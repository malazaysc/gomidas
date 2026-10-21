// Own translation unit: JUCE's X11 API is only declared with JUCE_GUI_BASICS_INCLUDE_XHEADERS,
// which also pulls in Xlib — whose macros (None, Bool, Status, …) must not leak elsewhere.
#define JUCE_GUI_BASICS_INCLUDE_XHEADERS 1
#include <juce_gui_basics/juce_gui_basics.h>
#include "X11EventWake.h"

namespace gomidas
{
#if JUCE_LINUX || JUCE_BSD
namespace
{
    constexpr int kIntervalMs = 100;
}

X11EventWake::X11EventWake()  { startTimer (kIntervalMs); }
X11EventWake::~X11EventWake() { stopTimer(); }

void X11EventWake::timerCallback()
{
    auto* xws = juce::XWindowSystem::getInstanceWithoutCreating();
    auto* display = xws != nullptr ? xws->getDisplay() : nullptr;
    if (display == nullptr || juce::ComponentPeer::getNumPeers() == 0)
        return;

    auto& x = *juce::X11Symbols::getInstance();
    juce::XWindowSystemUtilities::ScopedXLock lock;

    // Only what is already buffered in Xlib's queue — reading the socket here would be the very
    // round trip that strands events.
    if (x.xEventsQueued (display, QueuedAlready) <= 0)
    {
        ticksWithQueuedEvents = 0;
        return;
    }

    // One tick of queued events is normal (JUCE's callback may simply not have run yet); two
    // means nothing is going to wake it.
    if (++ticksWithQueuedEvents < 2)
        return;

    ticksWithQueuedEvents = 0;

    // With an empty event mask, XSendEvent delivers to the client that created the window — us.
    // An unknown message_type is ignored by JUCE's handleClientMessageEvent; its only effect is
    // that the socket becomes readable and JUCE drains the whole queue.
    const auto target = (::Window) juce::ComponentPeer::getPeer (0)->getNativeHandle();
    if (target == 0)
        return;

    static const ::Atom wakeAtom = x.xInternAtom (display, "GOMIDAS_EVENT_WAKE", False);

    XEvent event {};
    event.xclient.type = ClientMessage;
    event.xclient.window = target;
    event.xclient.message_type = wakeAtom;
    event.xclient.format = 32;

    x.xSendEvent (display, target, False, NoEventMask, &event);
    x.xFlush (display);
}
#else
X11EventWake::X11EventWake()  {}
X11EventWake::~X11EventWake() {}
void X11EventWake::timerCallback() {}
#endif
}
