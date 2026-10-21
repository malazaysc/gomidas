// Pins the GOM-92 policy: GOMIDAS_SCALE, else Hyprland's monitor scale (1 if Hyprland scales
// XWayland itself), else the desktop scale JUCE detected — never a DPI guess, never a cap.
// Build with -DGOMIDAS_BUILD_TESTS=ON, then: ./ui_scale_test
#include "ui/UiScale.h"
#include <cstdio>
#include <initializer_list>

using gomidas::chooseUiScale;
using gomidas::HyprlandInfo;
using Source = gomidas::UiScaleChoice::Source;

static int failures = 0;

static void check (const gomidas::UiScaleChoice& got, int scale, Source source, const char* what)
{
    if (got.scale != scale || got.source != source)
    {
        std::printf ("FAIL: %s (got scale %d source %d, want %d / %d)\n",
                     what, got.scale, (int) got.source, scale, (int) source);
        ++failures;
    }
}

int main()
{
    // Hyprland: the configured monitor scale wins, whatever the session's GDK_SCALE says.
    check (chooseUiScale (nullptr, HyprlandInfo { 1.0, true }, 1.0), 1, Source::hyprland, "this machine: monitor scale 1");
    check (chooseUiScale (nullptr, HyprlandInfo { 2.0, true }, 1.0), 2, Source::hyprland, "Omarchy on 4K at scale 2 (JUCE said 1)");
    check (chooseUiScale (nullptr, HyprlandInfo { 1.5, true }, 1.0), 2, Source::hyprland, "fractional 1.5 rounds to 2");
    check (chooseUiScale (nullptr, HyprlandInfo { 1.25, true }, 1.0), 1, Source::hyprland, "fractional 1.25 rounds to 1");
    check (chooseUiScale (nullptr, HyprlandInfo { 2.0, false }, 1.0), 1, Source::hyprlandCompositorScaled,
           "force_zero_scaling off: Hyprland upscales, render at 1");

    // Elsewhere: the desktop's own setting as JUCE reads it, uncapped (accessibility 200% on 1080p stays 2).
    check (chooseUiScale (nullptr, std::nullopt, 1.0), 1, Source::desktop, "GNOME 100% on 4K stays 1");
    check (chooseUiScale (nullptr, std::nullopt, 2.0), 2, Source::desktop, "GNOME 200% -> 2, even on 1080p");
    check (chooseUiScale (nullptr, std::nullopt, 0.0), 1, Source::desktop, "unknown -> 1");

    // Override wins over everything.
    check (chooseUiScale ("2", HyprlandInfo { 1.0, true }, 1.0), 2, Source::override, "GOMIDAS_SCALE=2 on Hyprland");
    check (chooseUiScale ("1", std::nullopt, 2.0), 1, Source::override, "GOMIDAS_SCALE=1 on a 2x desktop");

    // Rejected overrides fall through and are reported.
    for (const char* bad : { "1.5", "9", "abc", "0" })
    {
        const auto c = chooseUiScale (bad, HyprlandInfo { 2.0, true }, 1.0);
        check (c, 2, Source::hyprland, "invalid GOMIDAS_SCALE falls through");
        if (! c.overrideRejected) { std::printf ("FAIL: GOMIDAS_SCALE=%s not reported as rejected\n", bad); ++failures; }
    }
    if (chooseUiScale ("", std::nullopt, 1.0).overrideRejected) { std::printf ("FAIL: empty override reported as rejected\n"); ++failures; }

    // The JUCE global factor that turns the display into the chosen scale.
    auto near = [] (double a, double b) { return a > b - 1.0e-9 && a < b + 1.0e-9; };
    struct { double display, global; int chosen; double want; const char* what; } factors[] = {
        { 1.0, 1.0, 1, 1.0, "detected 1, choose 1 -> factor stays 1" },
        { 1.0, 1.0, 2, 2.0, "detected 1, choose 2 -> factor 2" },
        { 2.0, 1.0, 2, 1.0, "detected 2 (desktop), choose 2 -> factor 1" },
        { 2.0, 1.0, 1, 0.5, "detected 2, override 1 -> factor 0.5" },
        { 4.0, 2.0, 2, 1.0, "display 4 with global 2 already applied (detected 2), choose 2 -> 1" },
        { 1.5, 1.0, 2, 2.0 / 1.5, "fractional desktop 1.5, choose 2" },
        { 0.0, 1.0, 2, 1.0, "no display scale -> unchanged" },
    };
    for (const auto& f : factors)
        if (! near (gomidas::globalScaleFactorFor (f.display, f.global, f.chosen), f.want))
        { std::printf ("FAIL: %s (got %f, want %f)\n", f.what, gomidas::globalScaleFactorFor (f.display, f.global, f.chosen), f.want); ++failures; }

    if (failures == 0)
        std::printf ("PASS: ui_scale_test\n");
    return failures == 0 ? 0 : 1;
}
