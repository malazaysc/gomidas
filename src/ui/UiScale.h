#pragma once
// One UI scale for both halves of the Linux app (GOM-92). The window is JUCE and the editor is a
// WebKitGTK view inside it; each toolkit picks its own scale, and when they disagree the page is
// laid out at the wrong size inside its box (Omarchy exports GDK_SCALE=2 to every app, so on a
// scale-1 monitor WebKit rendered 2x while JUCE laid out at 1x: an "ultra giant" UI).
//
// Neither source can be trusted as is: GDK_SCALE is a session-wide setting that need not match
// the monitor, and JUCE stops at GNOME's gsettings scaling-factor (0 → 1.0 on Omarchy) before it
// ever looks at the DPI, so a real HiDPI screen would come out tiny. So the scale is derived from
// the display the app opens on — round(dpi / 96), the Chromium rule JUCE itself falls back on —
// and applied to both. GOMIDAS_SCALE overrides it (integer 1-4).
//
// Header-only pure part so tests/ui_scale_test.cpp can pin it without a display.
#include <cmath>
#include <cstdlib>

namespace gomidas
{
// The integer scale for a display of `dpi`, or the override when it is a valid 1-4 integer.
inline int chooseUiScale (double dpi, const char* overrideValue)
{
    if (overrideValue != nullptr && *overrideValue != '\0')
    {
        char* end = nullptr;
        const long forced = std::strtol (overrideValue, &end, 10);
        if (end != overrideValue && *end == '\0' && forced >= 1 && forced <= 4)
            return (int) forced;
    }

    if (! (dpi > 0))          // unknown DPI: no scaling
        return 1;

    const auto scale = (int) std::lround (dpi / 96.0);
    return scale < 1 ? 1 : (scale > 4 ? 4 : scale);
}

// Linux/BSD only, and before any WebBrowserComponent exists (GTK reads GDK_SCALE when it starts):
// picks the scale for the primary display and applies it to JUCE (global scale factor) and GTK
// (GDK_SCALE, GDK_DPI_SCALE cleared). Logs the choice to stderr. No-op elsewhere.
void applyUiScale();
}
