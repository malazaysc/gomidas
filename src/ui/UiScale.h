#pragma once
// One UI scale for both halves of the Linux app (GOM-92). The window is JUCE and the editor is a
// WebKitGTK view inside it; each toolkit picks its own scale, and when they disagree the page is
// laid out at the wrong size inside its box (Omarchy exports GDK_SCALE=2 to every app, so on a
// scale-1 monitor WebKit rendered 2x while JUCE laid out at 1x: an "ultra giant" UI).
//
// GDK_SCALE is a session-wide setting that need not match the monitor, so it is not used. The
// scale comes from, in order:
//   1. GOMIDAS_SCALE (integer 1-4), the user's explicit choice;
//   2. the scale JUCE detected, when a desktop setting asked for more than 1 (XSETTINGS
//      Gdk/WindowScalingFactor, a non-zero GNOME scaling-factor, Ubuntu's per-output factor);
//   3. otherwise the display's DPI, round(dpi / 96) — JUCE never gets there on Omarchy, because
//      gsettings reports scaling-factor 0 and JUCE turns that into 1.0;
// and (2) and (3) are then capped so the logical screen still fits the main window's 900x600
// minimum: a 13" 1080p laptop (~166 dpi) or a TV reporting a bogus size stays at 1.
//
// Header-only pure part so tests/ui_scale_test.cpp can pin it without a display.
#include <cmath>
#include <cstdlib>

namespace gomidas
{
struct UiScaleChoice
{
    enum class Source { override, desktopSetting, dpi };
    int scale = 1;
    Source source = Source::dpi;
    bool overrideRejected = false;   // GOMIDAS_SCALE was set but not a valid 1-4 integer
};

constexpr int kMinWindowWidth  = 900;   // keep in step with MainWindow's setResizeLimits (Main.cpp)
constexpr int kMinWindowHeight = 600;

inline UiScaleChoice chooseUiScale (double dpi, double detectedScale,
                                    int screenWidthPx, int screenHeightPx,
                                    const char* overrideValue)
{
    UiScaleChoice choice;

    if (overrideValue != nullptr && *overrideValue != '\0')
    {
        char* end = nullptr;
        const long forced = std::strtol (overrideValue, &end, 10);
        if (end != overrideValue && *end == '\0' && forced >= 1 && forced <= 4)
        {
            choice.scale = (int) forced;
            choice.source = UiScaleChoice::Source::override;
            return choice;
        }
        choice.overrideRejected = true;
    }

    int scale = 1;
    if (detectedScale > 1.01)
    {
        scale = (int) std::lround (detectedScale);
        choice.source = UiScaleChoice::Source::desktopSetting;
    }
    else if (dpi > 0)
    {
        scale = (int) std::lround (dpi / 96.0);
        choice.source = UiScaleChoice::Source::dpi;
    }

    // The logical screen must still hold the main window.
    if (screenWidthPx > 0 && screenHeightPx > 0)
    {
        const int fits = (int) std::floor (std::fmin ((double) screenWidthPx / kMinWindowWidth,
                                                      (double) screenHeightPx / kMinWindowHeight));
        if (scale > fits)
            scale = fits;
    }

    choice.scale = scale < 1 ? 1 : (scale > 4 ? 4 : scale);
    return choice;
}

// Linux/BSD only, and before any WebBrowserComponent exists (GTK reads GDK_SCALE when it starts):
// picks the scale for the primary display and applies it to JUCE (global scale factor) and GTK
// (GDK_SCALE). Logs the choice and its source to stderr. No-op elsewhere.
void applyUiScale();
}
