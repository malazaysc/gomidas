// Pins the GOM-92 rule: one UI scale from the display's DPI (round(dpi / 96), clamped 1-4),
// overridable with GOMIDAS_SCALE. Build with -DGOMIDAS_BUILD_TESTS=ON, then: ./ui_scale_test
#include "ui/UiScale.h"
#include <cstdio>

static int failures = 0;

static void check (int got, int want, const char* what)
{
    if (got != want) { std::printf ("FAIL: %s (got %d, want %d)\n", what, got, want); ++failures; }
}

int main()
{
    check (gomidas::chooseUiScale (81.0,  nullptr), 1, "3840x1080 ultrawide at 81 dpi -> 1");
    check (gomidas::chooseUiScale (96.0,  nullptr), 1, "96 dpi -> 1");
    check (gomidas::chooseUiScale (163.0, nullptr), 2, "27in 4K at 163 dpi -> 2");
    check (gomidas::chooseUiScale (192.0, nullptr), 2, "192 dpi -> 2");
    check (gomidas::chooseUiScale (290.0, nullptr), 3, "290 dpi -> 3");
    check (gomidas::chooseUiScale (900.0, nullptr), 4, "absurd dpi is clamped to 4");
    check (gomidas::chooseUiScale (0.0,   nullptr), 1, "unknown dpi -> 1");
    check (gomidas::chooseUiScale (-5.0,  nullptr), 1, "negative dpi -> 1");

    check (gomidas::chooseUiScale (81.0,  "2"),     2, "GOMIDAS_SCALE=2 overrides a low-dpi display");
    check (gomidas::chooseUiScale (163.0, "1"),     1, "GOMIDAS_SCALE=1 overrides a HiDPI display");
    check (gomidas::chooseUiScale (163.0, ""),      2, "empty override is ignored");
    check (gomidas::chooseUiScale (163.0, "1.5"),   2, "non-integer override is ignored");
    check (gomidas::chooseUiScale (163.0, "9"),     2, "out-of-range override is ignored");
    check (gomidas::chooseUiScale (163.0, "abc"),   2, "garbage override is ignored");

    if (failures == 0)
        std::printf ("PASS: ui_scale_test\n");
    return failures == 0 ? 0 : 1;
}
