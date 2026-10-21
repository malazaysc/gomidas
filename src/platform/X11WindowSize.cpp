#include "X11WindowSize.h"
#include <X11/Xlib.h>

namespace gomidas
{
bool queryX11WindowSize (void* nativeHandle, int& width, int& height)
{
    if (nativeHandle == nullptr)
        return false;

    // A short-lived connection of our own: JUCE's display is internal. Geometry is server state,
    // so any connection sees the size the window manager actually applied.
    Display* display = XOpenDisplay (nullptr);
    if (display == nullptr)
        return false;

    // A window that no longer exists raises BadWindow; don't let Xlib's default handler exit().
    auto previous = XSetErrorHandler ([] (Display*, XErrorEvent*) { return 0; });
    XWindowAttributes attributes {};
    const bool ok = XGetWindowAttributes (display, (Window) nativeHandle, &attributes) != 0;
    XSync (display, False);
    XSetErrorHandler (previous);
    XCloseDisplay (display);

    if (! ok)
        return false;

    width = attributes.width;
    height = attributes.height;
    return true;
}
}
