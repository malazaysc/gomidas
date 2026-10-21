#pragma once
// Reads a top-level window's real size from the X server (GOM-91). Kept in its own translation
// unit because Xlib's macros (None, Bool, Status, …) collide with JUCE names.
namespace gomidas
{
// Physical size of X window `nativeHandle` (a ComponentPeer::getNativeHandle()). Returns false if
// the display can't be opened or the window doesn't exist. Linux/BSD builds only.
bool queryX11WindowSize (void* nativeHandle, int& width, int& height);
}
