#pragma once
#include <juce_core/juce_core.h>
#include <filesystem>

// The subdirectory next to the binary that holds bundled resources off macOS. Defined once in
// CMakeLists.txt (GOMIDAS_RESOURCES_SUBDIR) so the code and the copy step cannot disagree.
#if ! JUCE_MAC && ! defined (GOMIDAS_RESOURCES_SUBDIR)
 #error "GOMIDAS_RESOURCES_SUBDIR must come from CMakeLists.txt (target_compile_definitions) so the code and the copy step agree"
#endif

namespace gomidas
{
// Where bundled runtime resources (FluidR3_GM.sf2, instruments/) live (GOM-85). Every lookup of a
// bundled file goes through here — the two copies of a hard-coded "Contents/Resources" path were
// how Linux silently lost FluidR3 and the SFZ presets.
//   macOS:  Gomidas.app/Contents/Resources
//   other:  <directory of the real executable>/GOMIDAS_RESOURCES_SUBDIR
// Off macOS the executable is found through /proc/self/exe (hostApplicationPath): JUCE's
// currentApplicationFile is argv[0] resolved against the CWD, which is wrong when Gomidas is
// started from PATH, a symlink or a .desktop file. Only the build-tree layout is covered — an
// installed build (e.g. /usr/bin) needs an install step and a FHS lookup first.
inline juce::File resourcesDir()
{
   #if JUCE_MAC
    return juce::File::getSpecialLocation (juce::File::currentApplicationFile).getChildFile ("Contents/Resources");
   #else
    return juce::File::getSpecialLocation (juce::File::hostApplicationPath)
               .getParentDirectory().getChildFile (GOMIDAS_RESOURCES_SUBDIR);
   #endif
}

// juce::File <-> std::filesystem::path without mangling non-ASCII names: a narrow std::string is
// read in the ANSI code page on Windows, so go through UTF-16 there.
inline std::filesystem::path toFsPath (const juce::File& f)
{
   #if JUCE_WINDOWS
    return std::filesystem::path (f.getFullPathName().toWideCharPointer());
   #else
    return std::filesystem::path (f.getFullPathName().toStdString());
   #endif
}

inline juce::File toJuceFile (const std::filesystem::path& p)
{
   #if JUCE_WINDOWS
    return juce::File (juce::String (p.wstring().c_str()));
   #else
    return juce::File (juce::String (p.string()));
   #endif
}
}
