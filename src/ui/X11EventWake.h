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
// The watchdog reads Xlib's queued count (QueuedAlready: no I/O, no round trip). If events have
// sat there for two ticks, it sends the app a no-op ClientMessage, which makes the socket
// readable, so JUCE's own loop drains everything in order through its normal handlers. It fixes
// every window at once and changes no bounds itself. No-op off Linux/BSD.
class X11EventWake : private juce::Timer
{
public:
    X11EventWake();
    ~X11EventWake() override;

private:
    void timerCallback() override;

    int ticksWithQueuedEvents = 0;

    JUCE_DECLARE_NON_COPYABLE (X11EventWake)
};
}
