// Own translation unit: JUCE's X11 API is only declared with JUCE_GUI_BASICS_INCLUDE_XHEADERS,
// which also pulls in Xlib — whose macros (None, Bool, Status, …) must not leak elsewhere.
#define JUCE_GUI_BASICS_INCLUDE_XHEADERS 1
#include <juce_gui_basics/juce_gui_basics.h>
#include "X11EventWake.h"

#if JUCE_LINUX || JUCE_BSD
 // @internal in JUCE, but it is exactly the hook JUCE's own VST3 client uses to run an fd's
 // callback. A signature change fails to compile; a behaviour change would not, so a JUCE
 // upgrade must re-run the GOM-91 check (see CLAUDE.md).
 #include <juce_events/native/juce_EventLoopInternal_linux.h>
#endif

namespace gomidas
{
#if JUCE_LINUX || JUCE_BSD
X11EventWake::X11EventWake()  { startTimer (kIntervalMs); }
X11EventWake::~X11EventWake() { stopTimer(); }

void X11EventWake::timerCallback()
{
    auto* xws = juce::XWindowSystem::getInstanceWithoutCreating();
    auto* display = xws != nullptr ? xws->getDisplay() : nullptr;
    if (display == nullptr)
        return;

    auto& x = *juce::X11Symbols::getInstance();
    int queued = 0;
    {
        juce::XWindowSystemUtilities::ScopedXLock lock;
        if (connectionFd < 0)
            connectionFd = x.xConnectionNumber (display);   // fixed for the display's lifetime
        // Only what is already buffered in Xlib — reading the socket here would be the very kind
        // of round trip that strands events.
        queued = x.xEventsQueued (display, QueuedAlready);
    }

    // Run JUCE's own X fd callback (it drains with XPending/XNextEvent through its normal
    // handlers). Harmless if JUCE was about to run it anyway: it just finds the queue empty.
    if (queued > 0 && connectionFd >= 0)
        juce::LinuxEventLoopInternal::invokeEventLoopCallbackForFd (connectionFd);
}
#endif
}
