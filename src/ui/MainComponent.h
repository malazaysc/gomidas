#pragma once

#include <juce_gui_extra/juce_gui_extra.h>

// The one switch for "this binary draws a native menu bar": it compiles in setMacMainMenu AND is
// published to the page (kNativeMenus), which draws its own HTML bar whenever it is 0 (GOM-86).
#ifndef GOMIDAS_NATIVE_MENUS
 #if JUCE_MAC
  #define GOMIDAS_NATIVE_MENUS 1
 #else
  #define GOMIDAS_NATIVE_MENUS 0
 #endif
#endif
#if GOMIDAS_NATIVE_MENUS && ! JUCE_MAC
 #error "GOMIDAS_NATIVE_MENUS=1 needs setMacMainMenu, which exists only on macOS (it can only be forced to 0)"
#endif
#include "engine/AudioEngine.h"

namespace gomidas
{
// Top-level content: a transport bar over a WebBrowserComponent that hosts
// alphaTab. The browser owns the score model + rendering + editing UI; this
// component bridges edits down to the native AudioEngine and pushes the
// transport cursor back up.
class MainComponent : public juce::Component,
                      private juce::Timer,
                      private juce::MenuBarModel
{
public:
    MainComponent();
    ~MainComponent() override;

    void resized() override;
    void paint (juce::Graphics&) override;
    bool keyPressed (const juce::KeyPress& key) override;

private:
    void timerCallback() override;

    // ---- macOS menu bar (GP8-style File/Edit/Track/… menus) ----
    struct MenuEntry { juce::String label; juce::String action; }; // label "-" = separator; empty action = disabled
    std::vector<std::pair<juce::String, std::vector<MenuEntry>>> menus;
    void buildMenus();
    void runMenuAction (const juce::String& action);
    juce::StringArray getMenuBarNames() override;
    juce::PopupMenu getMenuForIndex (int topLevelMenuIndex, const juce::String& menuName) override;
    void menuItemSelected (int menuItemID, int topLevelMenuIndex) override;

    // ---- open + recent files (native, so we have real paths to persist) ----
    void openFileDialog();                       // native chooser → loadFileFromPath
    void loadFileFromPath (const juce::File& f); // dispatch into the WebView (text/base64)
    void addRecent (const juce::File& f);
    juce::File recentStoreFile() const;
   #if ! JUCE_MAC
    static juce::File defaultVst3Dir();
   #endif
    void loadRecentList();
   #if ! JUCE_MAC
    void migrateLegacyRecentList() const;
   #endif
    void saveRecentList() const;
    void pushRecentFiles();                      // -> window.gomidasRecentFiles (GOM-86)
    void clearRecentFiles();
    juce::StringArray recentFiles;               // full paths, most-recent first
    static constexpr int kRecentMax = 10;
    // Published to the page as gomidasNativeMenus so its HTML menu bar follows the binary (GOM-86).
    static constexpr bool kNativeMenus = GOMIDAS_NATIVE_MENUS != 0;

    // Bridge handlers (called from the WebView's JS).
    void handleSetSequence (const juce::var& payload);

    std::optional<juce::WebBrowserComponent::Resource> serveResource (const juce::String& url);

    // ---- input-plugin editor window ----
    void showPluginEditor();
    void closePluginEditor();
    struct PluginEditorWindow;
    std::unique_ptr<PluginEditorWindow> pluginWindow;

    AudioEngine engine;

    std::unique_ptr<juce::WebBrowserComponent> webView;
    double lastPushedTicks = -1.0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainComponent)
};
} // namespace gomidas
