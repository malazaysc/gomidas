#pragma once
// One UI scale for both halves of the Linux app (GOM-92). The window is JUCE and the editor is a
// WebKitGTK view inside it; each toolkit picks its own scale, and when they disagree the page is
// laid out at the wrong size inside its box (Omarchy exports GDK_SCALE=2 to every app, so on a
// scale-1 monitor WebKit rendered 2x while JUCE laid out at 1x: an "ultra giant" UI).
//
// Policy (decided with the user, 2026-10-21): follow the scale the user chose for their desktop,
// never guess.
//   1. GOMIDAS_SCALE (integer 1-4) — explicit override.
//   2. Hyprland: the focused monitor's scale as Hyprland reports it (`hyprctl -j monitors`), i.e.
//      what monitors.lua configures. If xwayland:force_zero_scaling is off, Hyprland scales
//      XWayland apps itself, so the app must render at 1.
//   3. Anywhere else: the scale JUCE reads from the desktop (XSETTINGS, GNOME/Ubuntu settings).
// The session-wide GDK_SCALE is ignored: it need not match the monitor (Omarchy sets 2 always).
// GTK only does integer device scales, so a fractional desktop scale is rounded and both halves
// use that same integer.
//
// Header-only pure part so tests/ui_scale_test.cpp can pin the policy without a display.
#include <cmath>
#include <cstdlib>
#include <optional>
#include <string>

namespace gomidas
{
struct UiScaleChoice
{
    enum class Source { override, hyprland, hyprlandCompositorScaled, desktop };
    int scale = 1;
    Source source = Source::desktop;
    bool overrideRejected = false;   // GOMIDAS_SCALE was set but not an integer 1-4
};

struct HyprlandInfo
{
    double monitorScale = 1.0;        // the focused monitor's configured scale
    bool forceZeroScaling = true;     // xwayland:force_zero_scaling
};

inline int toDeviceScale (double scale)
{
    const auto rounded = scale > 0 ? (int) std::lround (scale) : 1;
    return rounded < 1 ? 1 : (rounded > 4 ? 4 : rounded);
}

inline UiScaleChoice chooseUiScale (const char* overrideValue,
                                    std::optional<HyprlandInfo> hyprland,
                                    double desktopScale)
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

    if (hyprland.has_value())
    {
        if (! hyprland->forceZeroScaling)
        {
            choice.scale = 1;   // the compositor upscales XWayland windows itself
            choice.source = UiScaleChoice::Source::hyprlandCompositorScaled;
            return choice;
        }
        choice.scale = toDeviceScale (hyprland->monitorScale);
        choice.source = UiScaleChoice::Source::hyprland;
        return choice;
    }

    choice.scale = toDeviceScale (desktopScale);
    choice.source = UiScaleChoice::Source::desktop;
    return choice;
}

// Linux/BSD: decides the scale (querying Hyprland when running under it) and applies it to JUCE's
// global scale factor. Returns the scale for the web view, or 0 elsewhere. Logs the choice.
int applyUiScale();

// Sets GDK_SCALE for as long as it lives, then restores the previous value — so only the WebKit
// child (forked synchronously in the WebBrowserComponent constructor) inherits it, not zenity or
// anything else Gomidas launches later. scale <= 0 does nothing.
class ScopedGdkScale
{
public:
    explicit ScopedGdkScale (int scale);
    ~ScopedGdkScale();

private:
    bool active = false;
    std::optional<std::string> previous;
};
}
