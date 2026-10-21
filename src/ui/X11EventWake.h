#pragma once
#include <juce_events/juce_events.h>

namespace gomidas
{
// Wakes JUCE's X11 event loop when events are stranded in Xlib's queue (GOM-91).
//
// JUCE drains X events from an fd callback that runs only when the X socket becomes readable.
// Any synchronous Xlib round trip on JUCE's display (made by JUCE itself during startup, among
// others) reads whatever events are pending into Xlib's in-memory queue — after which the socket
// is no longer readable and JUCE does not look at them until some *new* X traffic arrives.
// Measured under Hyprland: ~100 events sat queued for the whole first seconds of every failing
// launch, among them the ConfigureNotify carrying the tile size. JUCE kept its initial 1280x820
// and, when later input finally drained the queue, dropped that stale event (serial check).
//
// Every 100ms the watchdog reads Xlib's queued count (QueuedAlready: no I/O, no round trip) and,
// if anything is queued, runs JUCE's own X fd callback, which drains it in order through JUCE's
// normal handlers. It fixes every window at once and changes no bounds itself. Cost: a 100ms timer
// for the life of the app; a stranded event waits at most ~one tick. (Making JUCE's drain loop
// re-check the queue itself would remove both — GOM-96.) Linux/BSD only.
#if JUCE_LINUX || JUCE_BSD
class X11EventWake : private juce::Timer
{
public:
    X11EventWake();
    ~X11EventWake() override;

private:
    void timerCallback() override;

    static constexpr int kIntervalMs = 100;
    int connectionFd = -1;

    JUCE_DECLARE_NON_COPYABLE (X11EventWake)
};
#endif
}
