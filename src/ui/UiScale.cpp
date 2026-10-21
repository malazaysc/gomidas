#include "UiScale.h"
#include <string>
#include <juce_gui_basics/juce_gui_basics.h>
#include <iostream>

namespace gomidas
{
#if JUCE_LINUX || JUCE_BSD
namespace
{
    // stdout of `hyprctl -j <args>`, or empty if hyprctl is missing, slow or fails. Waits FIRST and
    // reads after: readAllProcessOutput blocks until the child closes stdout, so reading first
    // would let a hung hyprctl (stalled compositor, stale socket) freeze startup with no limit.
    // The JSON is a few KB, well inside a pipe buffer, so the child can finish before we read.
    juce::var hyprctlJson (const juce::StringArray& args)
    {
        juce::ChildProcess process;
        juce::StringArray command { "hyprctl", "-j" };
        command.addArray (args);
        if (! process.start (command, juce::ChildProcess::wantStdOut))
            return {};
        if (! process.waitForProcessToFinish (1000))
        {
            process.kill();
            process.waitForProcessToFinish (500);   // reaps it (waitpid), so no zombie is left
            return {};
        }
        if (process.getExitCode() != 0)
            return {};
        return juce::JSON::parse (process.readAllProcessOutput());
    }

    std::optional<HyprlandInfo> queryHyprland()
    {
        if (std::getenv ("HYPRLAND_INSTANCE_SIGNATURE") == nullptr)
            return std::nullopt;

        const auto monitors = hyprctlJson ({ "monitors" });
        const auto* list = monitors.getArray();
        if (list == nullptr || list->isEmpty())
            return std::nullopt;

        // The window opens on the focused monitor; fall back to the first one.
        juce::var monitor = list->getFirst();
        for (const auto& m : *list)
            if ((bool) m.getProperty ("focused", false))
                monitor = m;

        HyprlandInfo info;
        info.monitorScale = (double) monitor.getProperty ("scale", 1.0);

        // This option decides the answer (off: Hyprland upscales XWayland itself), so an unreadable
        // value means "don't know" — fall back to the desktop path rather than guess either way.
        const auto option = hyprctlJson ({ "getoption", "xwayland:force_zero_scaling" });
        if (option.hasProperty ("bool"))
            info.forceZeroScaling = (bool) option.getProperty ("bool", false);
        else if (option.hasProperty ("int"))
            info.forceZeroScaling = (int) option.getProperty ("int", 0) != 0;
        else
            return std::nullopt;
        return info;
    }

    const char* describe (UiScaleChoice::Source source)
    {
        switch (source)
        {
            case UiScaleChoice::Source::override:                 return "GOMIDAS_SCALE";
            case UiScaleChoice::Source::hyprland:                 return "Hyprland monitor scale";
            case UiScaleChoice::Source::hyprlandCompositorScaled: return "Hyprland scales XWayland itself";
            case UiScaleChoice::Source::desktop:                  return "JUCE: desktop setting or display dpi";
        }
        return "?";
    }
}

void applyUiScale()
{
    auto& desktop = juce::Desktop::getInstance();
    const auto* display = desktop.getDisplays().getPrimaryDisplay();
    const auto globalNow = (double) desktop.getGlobalScaleFactor();
    const auto detected = display != nullptr && globalNow > 0 ? display->scale / globalNow : 1.0;

    // A valid override makes the Hyprland query irrelevant — and is the escape hatch if it misbehaves.
    const char* overrideValue = std::getenv ("GOMIDAS_SCALE");
    auto choice = chooseUiScale (overrideValue, std::nullopt, detected);
    std::optional<HyprlandInfo> hyprland;
    if (choice.source != UiScaleChoice::Source::override)
    {
        hyprland = queryHyprland();
        choice = chooseUiScale (overrideValue, hyprland, detected);
    }

    if (display != nullptr)
    {
        const auto factor = globalScaleFactorFor (display->scale, globalNow, choice.scale);
        if (std::abs (factor - globalNow) > 1.0e-6)
            desktop.setGlobalScaleFactor ((float) factor);
    }

    // Always set it — even without a display — so the session's GDK_SCALE never reaches WebKit.
    ::setenv ("GDK_SCALE", std::to_string (choice.scale).c_str(), 1);

    std::cerr << "[Gomidas] UI scale " << choice.scale << " (" << describe (choice.source);
    if (hyprland.has_value())
        std::cerr << "; monitor scale " << hyprland->monitorScale;
    std::cerr << "; JUCE detected " << detected << (display == nullptr ? ", no display info" : "") << ")" << std::endl;
    if (choice.overrideRejected)
        std::cerr << "[Gomidas] ignored GOMIDAS_SCALE=" << overrideValue << " (expected an integer 1-4)" << std::endl;
}
#else
void applyUiScale() {}
#endif
}
