#include "UiScale.h"
#include <juce_gui_basics/juce_gui_basics.h>
#include <iostream>

namespace gomidas
{
#if JUCE_LINUX || JUCE_BSD
namespace
{
    // stdout of `hyprctl -j <args>`, or empty if hyprctl is missing, slow or fails.
    juce::var hyprctlJson (const juce::StringArray& args)
    {
        juce::ChildProcess process;
        juce::StringArray command { "hyprctl", "-j" };
        command.addArray (args);
        if (! process.start (command, juce::ChildProcess::wantStdOut))
            return {};
        const auto output = process.readAllProcessOutput();
        if (! process.waitForProcessToFinish (1000) || process.getExitCode() != 0)
            return {};
        return juce::JSON::parse (output);
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

        const auto option = hyprctlJson ({ "getoption", "xwayland:force_zero_scaling" });
        if (option.hasProperty ("bool"))
            info.forceZeroScaling = (bool) option.getProperty ("bool", true);
        else if (option.hasProperty ("int"))
            info.forceZeroScaling = (int) option.getProperty ("int", 1) != 0;
        return info;
    }

    const char* describe (UiScaleChoice::Source source)
    {
        switch (source)
        {
            case UiScaleChoice::Source::override:                 return "GOMIDAS_SCALE";
            case UiScaleChoice::Source::hyprland:                 return "Hyprland monitor scale";
            case UiScaleChoice::Source::hyprlandCompositorScaled: return "Hyprland scales XWayland itself";
            case UiScaleChoice::Source::desktop:                  return "desktop setting";
        }
        return "?";
    }
}

int applyUiScale()
{
    auto& desktop = juce::Desktop::getInstance();
    const auto* display = desktop.getDisplays().getPrimaryDisplay();
    if (display == nullptr)
        return 0;

    // JUCE's own per-display scale (what it read from the desktop), without any global factor.
    const auto globalNow = (double) desktop.getGlobalScaleFactor();
    const auto detected = globalNow > 0 ? display->scale / globalNow : display->scale;

    const char* overrideValue = std::getenv ("GOMIDAS_SCALE");
    const auto hyprland = queryHyprland();
    const auto choice = chooseUiScale (overrideValue, hyprland, detected);

    // Display::scale is (JUCE's per-display scale) x (global factor): make the product the choice.
    if (detected > 0 && std::abs (choice.scale / detected - globalNow) > 1.0e-6)
        desktop.setGlobalScaleFactor ((float) (choice.scale / detected));

    std::cerr << "[Gomidas] UI scale " << choice.scale << " (" << describe (choice.source);
    if (hyprland.has_value())
        std::cerr << "; monitor scale " << hyprland->monitorScale;
    std::cerr << "; JUCE detected " << detected << ")" << std::endl;
    if (choice.overrideRejected)
        std::cerr << "[Gomidas] ignored GOMIDAS_SCALE=" << overrideValue << " (expected an integer 1-4)" << std::endl;

    return choice.scale;
}

ScopedGdkScale::ScopedGdkScale (int scale)
{
    if (scale <= 0)
        return;
    if (const char* old = std::getenv ("GDK_SCALE"))
        previous = std::string (old);
    ::setenv ("GDK_SCALE", std::to_string (scale).c_str(), 1);
    active = true;
}

ScopedGdkScale::~ScopedGdkScale()
{
    if (! active)
        return;
    if (previous.has_value())
        ::setenv ("GDK_SCALE", previous->c_str(), 1);
    else
        ::unsetenv ("GDK_SCALE");
}
#else
int applyUiScale() { return 0; }
ScopedGdkScale::ScopedGdkScale (int) {}
ScopedGdkScale::~ScopedGdkScale() {}
#endif
}
