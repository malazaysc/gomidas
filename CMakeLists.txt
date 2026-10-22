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

# ---- sfizz (SFZ sample engine, BSD/ISC) -------------------------------------
# Realistic sample-based instruments (see docs/REALISTIC_SOUND.md). We build only the
# static library — no LV2/VST/AU plugins, no JACK, no CLI render tool, no tests/demos.
# SFIZZ_USE_SNDFILE=OFF uses sfizz's vendored audio loader (dr_libs), so we don't need
# an external libsndfile. Consumers link the sfizz::sfizz alias.
set(SFIZZ_SHARED    OFF CACHE BOOL "" FORCE)
set(SFIZZ_RENDER    OFF CACHE BOOL "" FORCE)
set(SFIZZ_JACK      OFF CACHE BOOL "" FORCE)
set(SFIZZ_LV2       OFF CACHE BOOL "" FORCE)
set(SFIZZ_LV2_UI    OFF CACHE BOOL "" FORCE)
set(SFIZZ_VST       OFF CACHE BOOL "" FORCE)
set(SFIZZ_AU        OFF CACHE BOOL "" FORCE)
set(SFIZZ_TESTS     OFF CACHE BOOL "" FORCE)
set(SFIZZ_DEMOS     OFF CACHE BOOL "" FORCE)
set(SFIZZ_DEVTOOLS  OFF CACHE BOOL "" FORCE)
set(SFIZZ_BENCHMARKS OFF CACHE BOOL "" FORCE)
set(SFIZZ_USE_SNDFILE OFF CACHE BOOL "" FORCE)
set(ENABLE_LTO      OFF CACHE BOOL "" FORCE)   # faster dev builds; revisit for release
# sfizz 1.2.3 doesn't build cleanly with modern toolchains; patch_sfizz.py fixes the arm64
# compile flags and an atomic_queue conformance error (Apple Silicon / clang) and a missing
# <cstdint> in vendored abseil (GCC 16, Linux). The script's hash is passed as an argument the
# script ignores: it puts the script's content into the patch step, so editing the script
# re-patches an existing build/_deps/sfizz-src instead of silently keeping the old patch.
file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/cmake/patch_sfizz.py" GOMIDAS_SFIZZ_PATCH_HASH)
FetchContent_Declare(sfizz
  GIT_REPOSITORY https://github.com/sfztools/sfizz.git
  GIT_TAG        1.2.3
  PATCH_COMMAND  python3 "${CMAKE_CURRENT_SOURCE_DIR}/cmake/patch_sfizz.py" "${GOMIDAS_SFIZZ_PATCH_HASH}")
# Build sfizz (and its vendored abseil) as C++17: 1.2.3 is a C++17-era codebase that
# breaks under C++20 (uses the removed std::result_of, pre-char8_t u8"..." literals, etc.).
# Drop to 17 just for sfizz's add_subdirectory, then restore 20 for our own target.
set(CMAKE_CXX_STANDARD 17)
FetchContent_MakeAvailable(sfizz)
set(CMAKE_CXX_STANDARD 20)

# ---- App ---------------------------------------------------------------------
juce_add_gui_app(Gomidas
  PRODUCT_NAME  "Gomidas"
  COMPANY_NAME  "Alesi"
  BUNDLE_ID     "com.alesi.gomidas"
  # On Linux this is what links WebKitGTK + GTK (via pkg-config) for the WebBrowserComponent;
  # on macOS WKWebView is a system framework either way.
  NEEDS_WEB_BROWSER TRUE
  # Live input (Phase 2): the entitlement + Info.plist usage string must exist for the
  # audio input device to open. The device is still launched output-only, so no mic
  # prompt appears until the user enables live-input monitoring (AudioEngine::setLiveInput).
  MICROPHONE_PERMISSION_ENABLED TRUE
  MICROPHONE_PERMISSION_TEXT "Gomidas uses the microphone for live input monitoring and recording over your tracks.")

juce_generate_juce_header(Gomidas)

# ---- Web front-end: TypeScript codegen (GMD-31) ------------------------------
# The editor is TypeScript, compiled per-file to plain <script>-tag JavaScript in packages/core/dist/
# (see packages/core/tsconfig.json). tsc IS the whole build — no bundler — so the only thing CMake needs
# is to run it before reading the emitted files.
#
# This runs at CONFIGURE time on purpose: juce_add_binary_data() reads the files while
# generating, so they must already exist. The custom target below re-runs it per build, which
# is what catches an edited .ts.
#
# It also means `cmake --build` now depends on Node. That is the documented cost of the
# TypeScript decision (docs/WEB_PORT.md §1.1) and it fails loudly rather than embedding stale
# JavaScript — a silently out-of-date bundle is far worse than a clear error.
# pnpm, not npx (GMD-63): `npx tsc` silently DOWNLOADS a compiler from the registry when one is
# not installed locally, so a missing install would embed JavaScript built by an unpinned tsc
# instead of failing. `pnpm exec` only ever runs what the lockfile pinned.
find_program(PNPM_EXECUTABLE pnpm)
if (NOT PNPM_EXECUTABLE)
  message(FATAL_ERROR
    "pnpm not found, but the web front-end is TypeScript and must be compiled before it can be "
    "embedded. Install Node 20+ and pnpm (npm i -g pnpm), then run: pnpm install")
endif()

set(GOMIDAS_WEB_SRC "${CMAKE_CURRENT_SOURCE_DIR}/packages/core")
set(GOMIDAS_WEB_DIST "${GOMIDAS_WEB_SRC}/dist")

execute_process(
  COMMAND "${PNPM_EXECUTABLE}" exec tsc -p tsconfig.json
  WORKING_DIRECTORY "${GOMIDAS_WEB_SRC}"
  RESULT_VARIABLE GOMIDAS_TSC_RESULT
  OUTPUT_VARIABLE GOMIDAS_TSC_OUTPUT
  ERROR_VARIABLE  GOMIDAS_TSC_OUTPUT)
if (NOT GOMIDAS_TSC_RESULT EQUAL 0)
  message(FATAL_ERROR "TypeScript build failed:\n${GOMIDAS_TSC_OUTPUT}")
endif()

# Re-emit on every build so an edited .ts cannot leave a stale .js embedded.
add_custom_target(GomidasWeb ALL
  COMMAND "${PNPM_EXECUTABLE}" exec tsc -p tsconfig.json
  WORKING_DIRECTORY "${GOMIDAS_WEB_SRC}"
  COMMENT "Compiling web front-end (tsc -> web/dist)"
  VERBATIM)

# ---- Embedded web front-end (alphaTab) + GM SoundFont ------------------------
# Served to the WebBrowserComponent from memory via a ResourceProvider, and the
# SoundFont is loaded by the native TinySoundFont synth from memory.
#
# JavaScript comes from packages/core/dist/ (tsc output). Everything else is embedded straight from web/:
# index.html is not compiled, and alphaTab.min.js / juce_native_interop.js are excluded from
# the TypeScript project on purpose (a third-party bundle and a verbatim JUCE vendor file).
juce_add_binary_data(GomidasAssets
  HEADER_NAME GomidasAssets.h
  NAMESPACE   GomidasAssets
  SOURCES
    packages/core/index.html
    packages/core/dist/core/gomidas-core.js
    packages/core/dist/core/backend.js
    packages/core/dist/core/timebase.js
    packages/core/dist/core/sfz.js
    packages/core/dist/core/fx.js
    packages/core/dist/core/sf2.js
    packages/core/dist/core/packcache.js
    packages/core/dist/core/webfiles.js
    packages/core/dist/core/menus.js
    packages/core/dist/core/webshell.js
    packages/core/dist/core/keymap.js
    packages/core/dist/core/webaudio.js
    packages/core/dist/app.js
    packages/core/dist/editor.js
    packages/core/dist/fretboard.js
    packages/core/dist/grooves.js
    packages/core/juce_native_interop.js
    packages/core/alphaTab.min.js
    packages/core/Bravura.woff2
    packages/core/Bravura.woff
    packages/core/drumkit.webp
    assets/soundfont/sonivox.sf2)

# The embedded blob is generated from tsc output, so it must wait for tsc.
add_dependencies(GomidasAssets GomidasWeb)

target_sources(Gomidas PRIVATE
  src/Main.cpp
  src/ui/MainComponent.cpp
  src/ui/X11EventWake.cpp
  src/ui/UiScale.cpp
  src/engine/AudioEngine.cpp
  src/synth/SoundFontSynth.cpp
  src/synth/SfzSynth.cpp)

# Where bundled runtime resources go — must match src/AppResources.h (GOM-85). The layout follows
# the same predicate as the code's JUCE_MAC: macOS -> Gomidas.app/Contents/Resources (the bundle,
# populated by MACOSX_PACKAGE_LOCATION / the POST_BUILD copy below); everything else ->
# <binary dir>/${GOMIDAS_RESOURCES_SUBDIR}, one directory derived once and used for every copy. The
# subdirectory name reaches the code as a compile definition, so the two cannot disagree.
set(GOMIDAS_RESOURCES_SUBDIR "resources")
target_compile_definitions(Gomidas PRIVATE GOMIDAS_RESOURCES_SUBDIR="${GOMIDAS_RESOURCES_SUBDIR}")
if(CMAKE_SYSTEM_NAME STREQUAL "Darwin")
  set(GOMIDAS_BUNDLE_RESOURCES TRUE)
else()
  set(GOMIDAS_BUNDLE_RESOURCES FALSE)
  get_target_property(GOMIDAS_OUT_DIR Gomidas RUNTIME_OUTPUT_DIRECTORY)
  if(NOT GOMIDAS_OUT_DIR)
    message(FATAL_ERROR "Gomidas has no RUNTIME_OUTPUT_DIRECTORY (did juce_add_gui_app change?) - "
                        "can't place bundled resources next to the binary (GOM-85)")
  endif()
  set(GOMIDAS_RESOURCES_OUT "${GOMIDAS_OUT_DIR}/${GOMIDAS_RESOURCES_SUBDIR}")
endif()

# High-quality GM SoundFont (FluidR3, ~150MB, MIT). Too big to embed in the binary, so it ships
# next to it and is loaded at runtime. Falls back to the embedded sonivox bank when absent.
set(GOMIDAS_FLUID_SF "${CMAKE_CURRENT_SOURCE_DIR}/assets/soundfont/FluidR3_GM.sf2")
if(EXISTS "${GOMIDAS_FLUID_SF}")
  if(GOMIDAS_BUNDLE_RESOURCES)
    target_sources(Gomidas PRIVATE "${GOMIDAS_FLUID_SF}")
    set_source_files_properties("${GOMIDAS_FLUID_SF}" PROPERTIES MACOSX_PACKAGE_LOCATION Resources)
  else()
    # Re-placed on every build, but cheaply: a symlink on Unix (no 150 MB copy per build tree), a
    # copy_if_different on Windows. No DEPENDS on the source on purpose — it is git-ignored and may
    # vanish after configure, which must not break the build: the link then dangles, the app logs
    # "no FluidR3" and plays sonivox, exactly as without it.
    if(WIN32)
      set(GOMIDAS_FLUID_CMD copy_if_different)
    else()
      set(GOMIDAS_FLUID_CMD create_symlink)
    endif()
    add_custom_target(GomidasFluidSoundFont
      COMMAND ${CMAKE_COMMAND} -E make_directory "${GOMIDAS_RESOURCES_OUT}"
      COMMAND ${CMAKE_COMMAND} -E ${GOMIDAS_FLUID_CMD} "${GOMIDAS_FLUID_SF}" "${GOMIDAS_RESOURCES_OUT}/FluidR3_GM.sf2"
      COMMENT "Gomidas: placing FluidR3_GM.sf2 next to the binary")
    add_dependencies(Gomidas GomidasFluidSoundFont)
  endif()
  message(STATUS "Gomidas: bundling FluidR3_GM.sf2 SoundFont")
else()
  message(STATUS "Gomidas: FluidR3_GM.sf2 not found — using embedded sonivox bank")
  if(NOT GOMIDAS_BUNDLE_RESOURCES)
    # The source is gone: don't leave a dangling symlink (or a stale copy) for the app to find.
    add_custom_target(GomidasFluidSoundFontCleanup
      COMMAND ${CMAKE_COMMAND} -E rm -f "${GOMIDAS_RESOURCES_OUT}/FluidR3_GM.sf2")
    add_dependencies(Gomidas GomidasFluidSoundFontCleanup)
  endif()
endif()

# Bundle built-in SFZ instruments (small CC0 sets) with the app, so sfizz can load them by
# absolute path with no download. Big sets (e.g. Karoryfer drums ~2.3 GB) will fetch on first
# run instead — keep only small CC0 here.
set(GOMIDAS_INSTRUMENTS "${CMAKE_CURRENT_SOURCE_DIR}/assets/instruments")
if(EXISTS "${GOMIDAS_INSTRUMENTS}")
  if(GOMIDAS_BUNDLE_RESOURCES)
    add_custom_command(TARGET Gomidas POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_directory
              "${GOMIDAS_INSTRUMENTS}" "$<TARGET_FILE_DIR:Gomidas>/../Resources/instruments"
      COMMENT "Gomidas: bundling SFZ instruments into the app bundle")
  else()
    # A mirror (deletions and renames propagate), redone only when a source file changes or the
    # mirrored folder is gone — the stamp lives inside it. Not on every build: an rm -rf under a
    # running app would pull samples out from under sfizz. (copy_directory_if_different would need
    # CMake 3.26; the project supports 3.22.)
    file(GLOB_RECURSE GOMIDAS_INSTRUMENT_FILES CONFIGURE_DEPENDS "${GOMIDAS_INSTRUMENTS}/*")
    set(GOMIDAS_INSTRUMENTS_STAMP "${GOMIDAS_RESOURCES_OUT}/instruments/.mirrored")
    add_custom_command(OUTPUT "${GOMIDAS_INSTRUMENTS_STAMP}"
      COMMAND ${CMAKE_COMMAND} -E rm -rf "${GOMIDAS_RESOURCES_OUT}/instruments"
      COMMAND ${CMAKE_COMMAND} -E copy_directory "${GOMIDAS_INSTRUMENTS}" "${GOMIDAS_RESOURCES_OUT}/instruments"
      COMMAND ${CMAKE_COMMAND} -E touch "${GOMIDAS_INSTRUMENTS_STAMP}"
      DEPENDS ${GOMIDAS_INSTRUMENT_FILES}
      COMMENT "Gomidas: mirroring SFZ instruments next to the binary")
    add_custom_target(GomidasInstruments DEPENDS "${GOMIDAS_INSTRUMENTS_STAMP}")
    add_dependencies(Gomidas GomidasInstruments)
  endif()
endif()

target_include_directories(Gomidas PRIVATE src)

target_compile_definitions(Gomidas PRIVATE
  JUCE_WEB_BROWSER=1
  JUCE_USE_CURL=0
  JUCE_DISPLAY_SPLASH_SCREEN=0
  JUCE_APPLICATION_NAME_STRING="Gomidas"
  JUCE_APPLICATION_VERSION_STRING="0.1.0"
  # Host AU + VST3 plugins on the live-input chain (Phase 2 "play on top").
  JUCE_PLUGINHOST_AU=1
  JUCE_PLUGINHOST_VST3=1)

# Standalone test tools (off by default): -DGOMIDAS_BUILD_TESTS=ON
# Run with: cmake --build build && ctest --test-dir build --output-on-failure
option(GOMIDAS_BUILD_TESTS "Build standalone test tools (sfz_smoketest)" OFF)
if(GOMIDAS_BUILD_TESTS)
  enable_testing()

  add_executable(sfz_smoketest tests/sfz_smoketest.cpp)
  target_link_libraries(sfz_smoketest PRIVATE sfizz::sfizz)
  set_target_properties(sfz_smoketest PROPERTIES CXX_STANDARD 17)

  # TSF / SoundFontSynth smoke test — the default MIDI sound path. Compiles the synth
  # source directly (it defines TSF_IMPLEMENTATION) and links juce_audio_basics.
  add_executable(sf_smoketest tests/sf_smoketest.cpp src/synth/SoundFontSynth.cpp)
  target_include_directories(sf_smoketest PRIVATE src)
  target_link_libraries(sf_smoketest PRIVATE
    juce::juce_audio_basics
    juce::juce_recommended_config_flags)
  # Same as the app: no networking. On Linux JUCE otherwise expects libcurl to be linked.
  target_compile_definitions(sf_smoketest PRIVATE JUCE_USE_CURL=0)
  set_target_properties(sf_smoketest PROPERTIES CXX_STANDARD 20)

  # Assert each bundled CC0 SFZ instrument loads (incl. FLAC decode) and renders audio.
  add_test(NAME sfz_classical_guitar
           COMMAND sfz_smoketest
                   "${CMAKE_SOURCE_DIR}/assets/instruments/classical-guitar/classical-guitar.sfz")
  # Bass samples top out around key 46 — play E2 (40), in range, not middle C (60 is silent).
  add_test(NAME sfz_electric_bass
           COMMAND sfz_smoketest
                   "${CMAKE_SOURCE_DIR}/assets/instruments/electric-bass/electric-bass.sfz" 40)

  # Assert the bundled GM SoundFont loads and renders a note via TinySoundFont.
  add_test(NAME sf_gm_note
           COMMAND sf_smoketest "${CMAKE_SOURCE_DIR}/assets/soundfont/sonivox.sf2")

  # The BOM rule for embedded web assets on WebKitGTK (GOM-90). Header-only, no JUCE.
  add_executable(asset_bytes_test tests/asset_bytes_test.cpp)
  target_include_directories(asset_bytes_test PRIVATE src)
  set_target_properties(asset_bytes_test PROPERTIES CXX_STANDARD 20)
  add_test(NAME asset_bytes COMMAND asset_bytes_test)

  # Bundled preset paths must stay inside instruments/, symlinks resolved (GOM-85). Header-only.
  add_executable(app_resources_test tests/app_resources_test.cpp)
  target_include_directories(app_resources_test PRIVATE src)
  set_target_properties(app_resources_test PROPERTIES CXX_STANDARD 20)
  add_test(NAME app_resources COMMAND app_resources_test)

  # One UI scale for JUCE and the WebKitGTK view: GOMIDAS_SCALE, else Hyprland's monitor scale,
  # else the desktop's setting — never a DPI guess (GOM-92). Header-only.
  add_executable(ui_scale_test tests/ui_scale_test.cpp)
  target_include_directories(ui_scale_test PRIVATE src)
  set_target_properties(ui_scale_test PROPERTIES CXX_STANDARD 20)
  add_test(NAME ui_scale COMMAND ui_scale_test)

  # Aggregate target to build every test executable at once locally (`cmake --build build
  # --target gomidas_tests`). CI builds `all` (the app + these), so a new test target must not be
  # EXCLUDE_FROM_ALL.
  add_custom_target(gomidas_tests DEPENDS sfz_smoketest sf_smoketest asset_bytes_test ui_scale_test app_resources_test)
endif()

target_link_libraries(Gomidas PRIVATE
  GomidasAssets
  sfizz::sfizz
  juce::juce_audio_processors
  juce::juce_audio_utils
  juce::juce_audio_devices
  juce::juce_dsp
  juce::juce_gui_extra
  PUBLIC
  juce::juce_recommended_config_flags
  juce::juce_recommended_warning_flags)
