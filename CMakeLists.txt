cmake_minimum_required(VERSION 3.22)

project(Gomidas VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_OSX_DEPLOYMENT_TARGET)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Minimum macOS version" FORCE)
endif()

# ---- JUCE 8 ------------------------------------------------------------------
include(FetchContent)
FetchContent_Declare(JUCE
  GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
  GIT_TAG        8.0.13
  GIT_SHALLOW    TRUE)
FetchContent_MakeAvailable(JUCE)

# ---- App ---------------------------------------------------------------------
juce_add_gui_app(Gomidas
  PRODUCT_NAME  "Gomidas"
  COMPANY_NAME  "Alesi"
  BUNDLE_ID     "com.alesi.gomidas")
  # NOTE: live-input (Phase 2) will re-enable MICROPHONE_PERMISSION_ENABLED. The editor
  # needs output only, so we keep it off to avoid a mic prompt on launch.

juce_generate_juce_header(Gomidas)

# ---- Embedded web front-end (alphaTab) + GM SoundFont ------------------------
# Served to the WebBrowserComponent from memory via a ResourceProvider, and the
# SoundFont is loaded by the native TinySoundFont synth from memory.
juce_add_binary_data(GomidasAssets
  HEADER_NAME GomidasAssets.h
  NAMESPACE   GomidasAssets
  SOURCES
    web/index.html
    web/app.js
    web/editor.js
    web/fretboard.js
    web/juce_native_interop.js
    web/alphaTab.min.js
    web/Bravura.woff2
    web/Bravura.woff
    assets/soundfont/sonivox.sf2)

target_sources(Gomidas PRIVATE
  src/Main.cpp
  src/ui/MainComponent.cpp
  src/engine/AudioEngine.cpp
  src/synth/SoundFontSynth.cpp)

# High-quality GM SoundFont (FluidR3, ~150MB, MIT). Too big to embed in the binary,
# so it ships as a bundle resource and is loaded at runtime. Falls back to the
# embedded sonivox bank when this file is absent.
set(GOMIDAS_FLUID_SF "${CMAKE_CURRENT_SOURCE_DIR}/assets/soundfont/FluidR3_GM.sf2")
if(EXISTS "${GOMIDAS_FLUID_SF}")
  target_sources(Gomidas PRIVATE "${GOMIDAS_FLUID_SF}")
  set_source_files_properties("${GOMIDAS_FLUID_SF}" PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  message(STATUS "Gomidas: bundling FluidR3_GM.sf2 SoundFont")
else()
  message(STATUS "Gomidas: FluidR3_GM.sf2 not found — using embedded sonivox bank")
endif()

target_include_directories(Gomidas PRIVATE src)

target_compile_definitions(Gomidas PRIVATE
  JUCE_WEB_BROWSER=1
  JUCE_USE_CURL=0
  JUCE_DISPLAY_SPLASH_SCREEN=0
  JUCE_APPLICATION_NAME_STRING="Gomidas"
  JUCE_APPLICATION_VERSION_STRING="0.1.0")

target_link_libraries(Gomidas PRIVATE
  GomidasAssets
  juce::juce_audio_utils
  juce::juce_audio_devices
  juce::juce_dsp
  juce::juce_gui_extra
  PUBLIC
  juce::juce_recommended_config_flags
  juce::juce_recommended_warning_flags)
