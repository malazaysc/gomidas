// Pins the GOM-92 rule: GOMIDAS_SCALE, else a desktop scale setting above 1, else round(dpi/96),
// capped so the logical screen still fits the 900x600 main window.
// Build with -DGOMIDAS_BUILD_TESTS=ON, then: ./ui_scale_test
#include "ui/UiScale.h"
#include <cstdio>
#include <initializer_list>

using gomidas::chooseUiScale;
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
    // DPI rule (no desktop setting: JUCE detected 1).
    check (chooseUiScale (81.0,  1.0, 3840, 1080, nullptr), 1, Source::dpi, "3840x1080 ultrawide, 81 dpi -> 1");
    check (chooseUiScale (163.0, 1.0, 3840, 2160, nullptr), 2, Source::dpi, "27in 4K, 163 dpi -> 2");
    check (chooseUiScale (290.0, 1.0, 5120, 2880, nullptr), 3, Source::dpi, "5K at 290 dpi -> 3");
    check (chooseUiScale (0.0,   1.0, 1920, 1080, nullptr), 1, Source::dpi, "unknown dpi -> 1");

    // Fit cap: the logical screen must hold 900x600.
    check (chooseUiScale (166.0, 1.0, 1920, 1080, nullptr), 1, Source::dpi, "13in 1080p laptop, 166 dpi -> capped to 1");
    check (chooseUiScale (305.0, 1.0, 1920, 1080, nullptr), 1, Source::dpi, "TV reporting a bogus size -> capped to 1");
    check (chooseUiScale (220.0, 1.0, 2560, 1600, nullptr), 2, Source::dpi, "13in 2560x1600 laptop -> 2 (1280x800 fits)");

    // Desktop setting wins over DPI, still capped.
    check (chooseUiScale (96.0,  2.0, 3840, 2160, nullptr), 2, Source::desktopSetting, "GNOME scaling-factor 2 on a 96-dpi 4K -> 2");
    check (chooseUiScale (163.0, 2.0, 1920, 1080, nullptr), 1, Source::desktopSetting, "desktop 2x on 1080p is capped to 1");

    // Override wins, unconditionally.
    check (chooseUiScale (81.0,  1.0, 3840, 1080, "2"), 2, Source::override, "GOMIDAS_SCALE=2 on a low-dpi screen");
    check (chooseUiScale (163.0, 2.0, 3840, 2160, "1"), 1, Source::override, "GOMIDAS_SCALE=1 on HiDPI");

    // Rejected overrides fall through and are reported.
    for (const char* bad : { "1.5", "9", "abc", "0" })
    {
        const auto c = chooseUiScale (163.0, 1.0, 3840, 2160, bad);
        check (c, 2, Source::dpi, "invalid GOMIDAS_SCALE falls back to dpi");
        if (! c.overrideRejected) { std::printf ("FAIL: GOMIDAS_SCALE=%s not reported as rejected\n", bad); ++failures; }
    }
    if (chooseUiScale (163.0, 1.0, 3840, 2160, "").overrideRejected) { std::printf ("FAIL: empty override reported as rejected\n"); ++failures; }

    if (failures == 0)
        std::printf ("PASS: ui_scale_test\n");
    return failures == 0 ? 0 : 1;
}
