#pragma once

#include <juce_gui_extra/juce_gui_extra.h>
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
    void loadRecentList();
    void saveRecentList() const;
    juce::StringArray recentFiles;               // full paths, most-recent first
    static constexpr int kRecentMax = 10;
    static constexpr int kRecentIdBase = 9000;   // menu item id base for recent entries

    // Bridge handlers (called from the WebView's JS).
    void handleSetSequence (const juce::var& payload);

    std::optional<juce::WebBrowserComponent::Resource> serveResource (const juce::String& url);

    AudioEngine engine;

    std::unique_ptr<juce::WebBrowserComponent> webView;
    double lastPushedTicks = -1.0;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainComponent)
};
} // namespace gomidas
