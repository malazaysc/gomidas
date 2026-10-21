#pragma once
#include <juce_gui_basics/juce_gui_basics.h>
#include <optional>

namespace gomidas
{
// Keeps a top-level window's JUCE bounds in step with the bounds the X server really applied
// (GOM-91). A tiling window manager (Hyprland, i3, … via XWayland) resizes a window as it maps
// it, and JUCE can miss that ConfigureNotify: the X window has the tile's bounds while the
// content stays at its own size, clipped or letterboxed. Later resizes arrive normally, so
// after each map/activation this polls briefly and adopts the real SIZE when JUCE disagrees.
// (Re-reading the geometry on MapNotify does not fix it — measured 3/10: the tile is applied
// after the map, in the configure JUCE misses.)
//
// Call start() whenever the window may just have been (re)mapped: visibilityChanged (visible)
// and activeWindowStatusChanged (active) — not broughtToFront, which fires on every click.
// It polls for the whole window rather than stopping once JUCE and X agree: before the WM has
// tiled the window they agree on the pre-tile size, and stopping then is the bug. A correction
// restarts the window, so a re-tile JUCE then drops (its serial check) is still caught; at most
// kMaxCorrections per start, so a size that won't converge can't loop. Only the SIZE is corrected,
// via Component::setSize — JUCE's normal path, which re-sends JUCE's own position: tiling WMs
// ignore it; a floating WM that moved the window in the missed configure would see it move back
// (known limitation). No-op off Linux/BSD.
class X11BoundsSync : private juce::Timer
{
public:
    explicit X11BoundsSync (juce::Component& windowToSync) : window (windowToSync) {}

    void start();

private:
    void timerCallback() override;
    void check();

    static constexpr int kIntervalMs      = 200;
    static constexpr int kWindowMs        = 3000;
    static constexpr int kMaxCorrections  = 3;

    juce::Component& window;
    int ticks = 0;
    int corrections = 0;
    std::optional<juce::Rectangle<int>> lastMismatch;   // physical size (x/y ignored); adopted once read twice

    JUCE_DECLARE_NON_COPYABLE (X11BoundsSync)
};
}
