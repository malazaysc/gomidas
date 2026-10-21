#pragma once
#include <juce_gui_basics/juce_gui_basics.h>
#include <optional>

namespace gomidas
{
// Keeps a top-level window's JUCE bounds in step with the bounds the X server really applied
// (GOM-91). A tiling window manager (Hyprland, i3, … via XWayland) resizes a window as it maps
// it, and JUCE can miss that ConfigureNotify: the X window has the tile's bounds while the
// content stays at its own size, clipped or letterboxed. Later resizes arrive normally, so
// after each map/activation this polls briefly and adopts the real bounds when JUCE disagrees.
//
// Call start() whenever the window may just have been (re)mapped: visibilityChanged (visible)
// and activeWindowStatusChanged (active) — not broughtToFront, which fires on every click.
// It polls for the whole window rather than stopping once JUCE and X agree: before the WM has
// tiled the window they agree on the pre-tile size, and stopping then is the bug. Only a SIZE
// mismatch is corrected — positions don't clip content, and on reparenting WMs a client-vs-frame
// position difference is not an error. No-op off Linux/BSD.
class X11BoundsSync : private juce::Timer
{
public:
    explicit X11BoundsSync (juce::Component& windowToSync) : window (windowToSync) {}
    ~X11BoundsSync() override { stopTimer(); }

    void start();

private:
    void timerCallback() override;

    static constexpr int kIntervalMs = 200;
    static constexpr int kWindowMs   = 3000;

    juce::Component& window;
    int ticks = 0;
    std::optional<juce::Rectangle<int>> lastMismatch;   // physical; adopted only once read twice

    JUCE_DECLARE_NON_COPYABLE (X11BoundsSync)
};
}
