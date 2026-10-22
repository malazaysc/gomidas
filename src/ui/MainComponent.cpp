#include "MainComponent.h"
#include "GomidasAssets.h"
#include "AssetBytes.h"
#include "AppResources.h"
#include "PathGuard.h"

namespace gomidas
{
// A resizable window hosting the loaded input-plugin's own editor UI. On close it
// calls back so MainComponent drops its pointer (the processor outlives the editor).
struct MainComponent::PluginEditorWindow : public juce::DocumentWindow
{
    PluginEditorWindow (juce::AudioProcessorEditor* ed, const juce::String& name, std::function<void()> onClose)
        : juce::DocumentWindow (name.isNotEmpty() ? name : juce::String ("Plugin"),
                                juce::Colours::black, juce::DocumentWindow::closeButton),
          closeFn (std::move (onClose))
    {
        setUsingNativeTitleBar (true);
        setContentOwned (ed, true);
        setResizable (ed->isResizable(), false);
        centreWithSize (juce::jmax (320, getWidth()), juce::jmax (200, getHeight()));
        setVisible (true);
    }
    void closeButtonPressed() override { if (closeFn) closeFn(); }
    std::function<void()> closeFn;
};

namespace
{
// Map a requested URL path to an embedded resource name + MIME type.
// JS lives under /dist/ because tsc emits there (GMD-31) and index.html is SHARED with the
// browser build (GMD-32), where those files are served straight off disk. Keep the two in sync.
struct Asset { const char* path; const char* resource; const char* mime; };
const Asset kAssets[] = {
    { "/",               "index_html",      "text/html" },
    { "/index.html",     "index_html",      "text/html" },
    // Note: JUCE mangles "gomidas-core.js" to "gomidascore_js" (hyphen dropped).
    { "/dist/core/gomidas-core.js", "gomidascore_js", "text/javascript" },
    { "/dist/core/backend.js", "backend_js",    "text/javascript" },
    // Web Audio engine files. The desktop app does not USE them (it has AudioEngine), but
    // index.html is shared, so they must resolve or the page 404s mid-load.
    { "/dist/core/timebase.js", "timebase_js",  "text/javascript" },
    { "/dist/core/sfz.js",      "sfz_js",       "text/javascript" },
    { "/dist/core/fx.js",       "fx_js",        "text/javascript" },
    { "/dist/core/sf2.js",      "sf2_js",       "text/javascript" },
    { "/dist/core/packcache.js", "packcache_js", "text/javascript" },
    { "/dist/core/webfiles.js", "webfiles_js",  "text/javascript" },
    { "/dist/core/menus.js",    "menus_js",     "text/javascript" },
    { "/dist/core/webshell.js", "webshell_js",  "text/javascript" },
    { "/dist/core/keymap.js", "keymap_js",  "text/javascript" },
    { "/dist/core/webaudio.js", "webaudio_js",  "text/javascript" },
    { "/dist/app.js",    "app_js",          "text/javascript" },
    { "/dist/editor.js", "editor_js",       "text/javascript" },
    { "/dist/fretboard.js", "fretboard_js", "text/javascript" },
    { "/dist/grooves.js", "grooves_js",     "text/javascript" },
    { "/juce_native_interop.js", "juce_native_interop_js", "text/javascript" },
    { "/alphaTab.min.js","alphaTab_min_js", "text/javascript" },
    { "/Bravura.woff2",  "Bravura_woff2",   "font/woff2" },
    { "/Bravura.woff",   "Bravura_woff",    "font/woff" },
    { "/drumkit.webp",   "drumkit_webp",    "image/webp" },
};
} // namespace

MainComponent::MainComponent()
{
    engine.initialise();

    // ---- web view hosting alphaTab (owns the whole UI: toolbar, editor, fretboard) ----
    auto options = juce::WebBrowserComponent::Options{}
        .withNativeIntegrationEnabled()
        // The page draws its own menu bar unless this says the native one exists (GOM-86).
        .withInitialisationData ("gomidasNativeMenus", kNativeMenus)
        .withResourceProvider ([this] (const auto& url) { return serveResource (url); })
        .withNativeFunction ("setSequence",
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (! args.isEmpty())
                    handleSetSequence (args[0]);
                completion (juce::var());
            })
        .withNativeFunction ("play",
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            { engine.play(); completion (juce::var()); })
        .withNativeFunction ("stop",
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            { engine.stop(); completion (juce::var()); })
        .withNativeFunction ("seek",
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            { if (! args.isEmpty()) engine.seekTicks ((double) args[0]); completion (juce::var()); })
        .withNativeFunction ("panic",
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            { engine.panic(); completion (juce::var()); })
        .withNativeFunction ("setLoop",
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (! args.isEmpty())
                    if (auto* obj = args[0].getDynamicObject())
                        engine.setLoopRange ((double) obj->getProperty ("start"),
                                             (double) obj->getProperty ("end"));
                completion (juce::var());
            })
        .withNativeFunction ("saveProject",
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (! args.isEmpty())
                {
                    auto json = args[0].toString();
                    auto chooser = std::make_shared<juce::FileChooser> (
                        "Save Gomidas project", juce::File(), "*.gomidas");
                    chooser->launchAsync (juce::FileBrowserComponent::saveMode
                                          | juce::FileBrowserComponent::canSelectFiles
                                          | juce::FileBrowserComponent::warnAboutOverwriting,
                        [json, chooser] (const juce::FileChooser& fc)
                        {
                            auto f = fc.getResult();
                            if (f != juce::File())
                            {
                                if (! f.hasFileExtension ("gomidas")) f = f.withFileExtension ("gomidas");
                                f.replaceWithText (json);
                            }
                        });
                }
                completion (juce::var());
            })
        .withNativeFunction ("saveBinary",
            [] (const juce::Array<juce::var>& args,
                juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (! args.isEmpty())
                    if (auto* obj = args[0].getDynamicObject())
                    {
                        const auto ext = obj->getProperty ("ext").toString();
                        const auto b64 = obj->getProperty ("b64").toString();
                        juce::MemoryOutputStream mos;
                        if (juce::Base64::convertFromBase64 (mos, b64))
                        {
                            auto block = std::make_shared<juce::MemoryBlock> (mos.getMemoryBlock());
                            auto chooser = std::make_shared<juce::FileChooser> (
                                "Export", juce::File(), "*." + ext);
                            chooser->launchAsync (juce::FileBrowserComponent::saveMode
                                                  | juce::FileBrowserComponent::canSelectFiles
                                                  | juce::FileBrowserComponent::warnAboutOverwriting,
                                [block, ext, chooser] (const juce::FileChooser& fc)
                                {
                                    auto f = fc.getResult();
                                    if (f != juce::File())
                                    {
                                        if (! f.hasFileExtension (ext)) f = f.withFileExtension (ext);
                                        f.replaceWithData (block->getData(), block->getSize());
                                    }
                                });
                        }
                    }
                completion (juce::var());
            })
        .withNativeFunction ("openProject",
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                auto chooser = std::make_shared<juce::FileChooser> (
                    "Open Gomidas project", juce::File(), "*.gomidas");
                chooser->launchAsync (juce::FileBrowserComponent::openMode
                                      | juce::FileBrowserComponent::canSelectFiles,
                    [this, chooser] (const juce::FileChooser& fc)
                    {
                        auto f = fc.getResult();
                        if (f.existsAsFile())
                        {
                            auto content = f.loadFileAsString();
                            auto literal = juce::JSON::toString (juce::var (content));
                            if (webView != nullptr)
                                webView->evaluateJavascript ("window.gomidasLoadProject(" + literal + ");");
                        }
                    });
                completion (juce::var());
            })
        .withNativeFunction ("preview",
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (! args.isEmpty())
                    if (auto* obj = args[0].getDynamicObject())
                    {
                        const int channel = (int) obj->getProperty ("channel");
                        const int program = (int) obj->getProperty ("program");
                        const bool perc   = (bool) obj->getProperty ("percussion");
                        std::vector<int> keys;
                        if (auto* arr = obj->getProperty ("keys").getArray())
                            for (const auto& k : *arr) keys.push_back ((int) k);
                        engine.previewNotes (channel, program, perc, std::move (keys));
                    }
                completion (juce::var());
            })
        .withNativeFunction ("log",
            [] (const juce::Array<juce::var>& args,
                juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (! args.isEmpty())
                    std::cerr << "[web] " << args[0].toString() << std::endl;
                completion (juce::var());
            })
        .withNativeFunction ("setTempo",
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (! args.isEmpty())
                    engine.setTempoBpm ((double) args[0]);
                completion (juce::var());
            })
        .withNativeFunction ("setPlaybackRate",
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (! args.isEmpty())
                    engine.setPlaybackRate ((double) args[0]);
                completion (juce::var());
            })
        .withNativeFunction ("setLiveInput",
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                bool on = false;
                if (! args.isEmpty())
                    if (auto* obj = args[0].getDynamicObject())
                    {
                        const bool enabled = (bool) obj->getProperty ("enabled");
                        const float gain   = (float) (double) obj->getProperty ("gain");
                        on = engine.setLiveInput (enabled, gain > 0.0f ? gain : 1.0f);
                    }
                completion (juce::var (on));   // actual state (false if input couldn't open)
            })
        .withNativeFunction ("loadInputPlugin",
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                // One block per platform: title, start folder, filter and flags belong together.
               #if JUCE_MAC
                auto chooser = std::make_shared<juce::FileChooser> (
                    "Choose an AU (.component) or VST3 (.vst3) plugin",
                    juce::File ("/Library/Audio/Plug-Ins"), "*.vst3;*.component");
                const int pickFlags = juce::FileBrowserComponent::openMode
                                      | juce::FileBrowserComponent::canSelectFiles
                                      | juce::FileBrowserComponent::canSelectDirectories;
               #elif JUCE_LINUX || JUCE_BSD
                // A Linux VST3 is a DIRECTORY bundle (Foo.vst3/Contents/x86_64-linux/Foo.so), and JUCE's
                // zenity/kdialog path treats "files and directories" as files-only, so it could never
                // return one: pick in folder mode. No filter — "*.vst3" would also hide the folders on
                // the way to the bundle. Start folder ignored under xdg-desktop-portal: GOM-105.
                auto chooser = std::make_shared<juce::FileChooser> (
                    "Choose a VST3 plugin (the .vst3 folder)", defaultVst3Dir(), juce::String());
                const int pickFlags = juce::FileBrowserComponent::openMode
                                      | juce::FileBrowserComponent::canSelectDirectories;
               #else
                auto chooser = std::make_shared<juce::FileChooser> (
                    "Choose a VST3 (.vst3) plugin", defaultVst3Dir(), "*.vst3");
                const int pickFlags = juce::FileBrowserComponent::openMode
                                      | juce::FileBrowserComponent::canSelectFiles
                                      | juce::FileBrowserComponent::canSelectDirectories;
               #endif
                chooser->launchAsync (pickFlags,
                    [this, chooser] (const juce::FileChooser& fc)
                    {
                        auto f = fc.getResult();
                       #if JUCE_LINUX || JUCE_BSD
                        // Picked a folder INSIDE the bundle (…/Foo.vst3/Contents/x86_64-linux)? Load the bundle.
                        for (auto p = f; p != juce::File() && p != p.getParentDirectory(); p = p.getParentDirectory())
                            if (p.hasFileExtension ("vst3")) { f = p; break; }
                       #endif
                        if (f != juce::File())
                        {
                            closePluginEditor();                 // drop the old editor first
                            const bool ok = engine.loadInputPlugin (f);
                            if (ok) showPluginEditor();          // open the new plugin's UI
                            if (webView != nullptr)
                                webView->evaluateJavascript ("window.gomidasInputPluginLoaded && window.gomidasInputPluginLoaded("
                                    + juce::String (ok ? "true" : "false") + ","
                                    + juce::JSON::toString (juce::var (engine.inputPluginName())) + ");");
                        }
                    });
                completion (juce::var());
            })
        .withNativeFunction ("clearInputPlugin",
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            { closePluginEditor(); engine.clearInputPlugin(); completion (juce::var()); })
        .withNativeFunction ("showPluginEditor",
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            { showPluginEditor(); completion (juce::var()); })
        .withNativeFunction ("startRecording",
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                auto docs = juce::File::getSpecialLocation (juce::File::userMusicDirectory);
                auto chooser = std::make_shared<juce::FileChooser> (
                    "Record to WAV", docs.getChildFile ("Gomidas Recording.wav"), "*.wav");
                chooser->launchAsync (juce::FileBrowserComponent::saveMode
                                      | juce::FileBrowserComponent::canSelectFiles
                                      | juce::FileBrowserComponent::warnAboutOverwriting,
                    [this, chooser] (const juce::FileChooser& fc)
                    {
                        auto f = fc.getResult();
                        bool ok = false;
                        juce::String name;
                        if (f != juce::File())
                        {
                            if (! f.hasFileExtension ("wav")) f = f.withFileExtension ("wav");
                            ok = engine.startRecording (f);
                            name = f.getFileName();
                        }
                        if (webView != nullptr)
                            webView->evaluateJavascript ("window.gomidasRecording && window.gomidasRecording("
                                + juce::String (ok ? "true" : "false") + ","
                                + juce::JSON::toString (juce::var (name)) + ");");
                    });
                completion (juce::var());
            })
        .withNativeFunction ("stopRecording",
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                engine.stopRecording();
                if (webView != nullptr)
                    webView->evaluateJavascript ("window.gomidasRecording && window.gomidasRecording(false, \"\");");
                completion (juce::var());
            })
        .withNativeFunction ("setChannelMix",
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (! args.isEmpty())
                    if (auto* obj = args[0].getDynamicObject())
                        engine.setChannelMix ((int)   obj->getProperty ("channel"),
                                              (float) (double) obj->getProperty ("gain"),
                                              obj->hasProperty ("pan") ? (float) (double) obj->getProperty ("pan") : 0.5f);
                completion (juce::var());
            })
        .withNativeFunction ("setMasterMix",
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (! args.isEmpty())
                    if (auto* obj = args[0].getDynamicObject())
                        engine.setMasterMix ((float) (double) obj->getProperty ("gain"),
                                             obj->hasProperty ("pan") ? (float) (double) obj->getProperty ("pan") : 0.5f);
                completion (juce::var());
            })
        .withNativeFunction ("setMasterEq",
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (! args.isEmpty())
                    if (auto* obj = args[0].getDynamicObject())
                        engine.setMasterEq ((float) (double) obj->getProperty ("low"),
                                            (float) (double) obj->getProperty ("mid"),
                                            (float) (double) obj->getProperty ("high"));
                completion (juce::var());
            })
        .withNativeFunction ("setTrackEq",
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (! args.isEmpty())
                    if (auto* obj = args[0].getDynamicObject())
                        engine.setTrackEq ((int) obj->getProperty ("channel"),
                                           (float) (double) obj->getProperty ("low"),
                                           (float) (double) obj->getProperty ("mid"),
                                           (float) (double) obj->getProperty ("high"));
                completion (juce::var());
            })
        .withNativeFunction ("loadTrackSfz",
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                int channel = 0;
                if (! args.isEmpty())
                    if (auto* obj = args[0].getDynamicObject())
                        channel = (int) obj->getProperty ("channel");
                auto start = juce::File::getSpecialLocation (juce::File::userMusicDirectory);
                auto chooser = std::make_shared<juce::FileChooser> (
                    "Choose an SFZ instrument", start, "*.sfz");
                chooser->launchAsync (juce::FileBrowserComponent::openMode
                                      | juce::FileBrowserComponent::canSelectFiles,
                    [this, chooser, channel] (const juce::FileChooser& fc)
                    {
                        auto f = fc.getResult();
                        if (f.existsAsFile())
                        {
                            const bool ok = engine.loadChannelSfz (channel, f);
                            if (webView != nullptr)
                                webView->evaluateJavascript ("window.gomidasSfzLoaded && window.gomidasSfzLoaded("
                                    + juce::String (channel) + ","
                                    + juce::String (ok ? "true" : "false") + ","
                                    + juce::JSON::toString (juce::var (f.getFileNameWithoutExtension())) + ");");
                        }
                    });
                completion (juce::var());
            })
        .withNativeFunction ("loadTrackSfzPreset",
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                int channel = 0; juce::String rel, name;
                if (! args.isEmpty())
                    if (auto* obj = args[0].getDynamicObject())
                    {
                        channel = (int) obj->getProperty ("channel");
                        rel  = obj->getProperty ("file").toString();
                        name = obj->getProperty ("name").toString();
                    }
                // Built-in instruments live in <resources>/instruments (AppResources.h). The path comes
                // from the web view's JS (projects store only the preset id), so it must resolve inside
                // that folder. The ORIGINAL path is loaded: sfizz resolves sample= paths relative to the
                // .sfz it opened, and a symlinked .sfz must keep its own folder. (Bundled content is
                // trusted; whoever can write into the resources dir already controls the app.)
                const auto instruments = resourcesDir().getChildFile ("instruments");
                const auto f = instruments.getChildFile (rel);
                const bool ok = realPathInside (toFsPath (f), toFsPath (instruments)).has_value()
                                 && engine.loadChannelSfz (channel, f);
                if (webView != nullptr)
                    webView->evaluateJavascript ("window.gomidasSfzLoaded && window.gomidasSfzLoaded("
                        + juce::String (channel) + "," + juce::String (ok ? "true" : "false") + ","
                        + juce::JSON::toString (juce::var (name)) + ");");
                completion (juce::var());
            })
        .withNativeFunction ("clearTrackSfz",
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (! args.isEmpty())
                    if (auto* obj = args[0].getDynamicObject())
                        engine.clearChannelSfz ((int) obj->getProperty ("channel"));
                completion (juce::var());
            })
        .withNativeFunction ("minimizeWindow",
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                if (auto* peer = getPeer()) peer->setMinimised (true);
                completion (juce::var());
            })
        .withNativeFunction ("showAbout",
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                juce::NativeMessageBox::showMessageBoxAsync (
                    juce::MessageBoxIconType::InfoIcon, "Gomidas",
                    "Gomidas - a Guitar Pro-like tab editor.\n\n(c) 2026 Alexis Giovoglanian.",
                    this);
                completion (juce::var());
            })
        .withNativeFunction ("openFile",
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            { openFileDialog(); completion (juce::var()); })
        .withNativeFunction ("openRecent",
            [this] (const juce::Array<juce::var>& args,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                // By path, from both menus (GOM-86): the list can change while the unsaved-changes
                // guard is up, so a position could name a different file by the time it comes back.
                // Only a path native itself put in the list is opened — otherwise any script in the
                // page could read an arbitrary file through this bridge.
                if (! args.isEmpty() && args[0].isString())
                {
                    const auto path = args[0].toString();
                    if (recentFiles.contains (path))
                    {
                        loadFileFromPath (juce::File (path));
                    }
                    else
                    {
                        juce::NativeMessageBox::showMessageBoxAsync (juce::MessageBoxIconType::InfoIcon, "Gomidas",
                            "That file is no longer in the recent files list - open it with File > Open.", this);
                        pushRecentFiles();
                    }
                }
                completion (juce::var());
            })
        // The page draws its own menu bar where there is no global one (Linux/Windows, GOM-86); these
        // let its Open Recent section show and clear the same list the macOS submenu uses.
        .withNativeFunction ("getRecentFiles",
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            { pushRecentFiles(); completion (juce::var()); })
        .withNativeFunction ("clearRecent",
            [this] (const juce::Array<juce::var>&,
                    juce::WebBrowserComponent::NativeFunctionCompletion completion)
            {
                clearRecentFiles();
                completion (juce::var());
            });

    webView = std::make_unique<juce::WebBrowserComponent> (std::move (options));
    // The WebView handles keys itself when it holds first-responder focus; when it
    // doesn't, MainComponent receives them and forwards via keyPressed().
    webView->setWantsKeyboardFocus (false);
    addAndMakeVisible (*webView);
    webView->goToURL (juce::WebBrowserComponent::getResourceProviderRoot());

    setWantsKeyboardFocus (true);
    juce::Timer::callAfterDelay (600, [this] { grabKeyboardFocus(); });

    loadRecentList();
    buildMenus();
   #if GOMIDAS_NATIVE_MENUS
    juce::MenuBarModel::setMacMainMenu (this);   // elsewhere the page draws an HTML menu bar (GOM-86)
   #endif

    setSize (1280, 820);
    startTimerHz (30);
}

MainComponent::~MainComponent()
{
   #if GOMIDAS_NATIVE_MENUS
    juce::MenuBarModel::setMacMainMenu (nullptr);
   #endif
    closePluginEditor();   // destroy the editor before the engine frees the plugin
    stopTimer();
    engine.shutdown();
}

void MainComponent::showPluginEditor()
{
    closePluginEditor();
    auto* plugin = engine.pluginForEditor();
    if (plugin == nullptr || ! plugin->hasEditor())
        return;
    if (auto* ed = plugin->createEditorIfNeeded())
        pluginWindow = std::make_unique<PluginEditorWindow> (ed, engine.inputPluginName(),
            [this] { closePluginEditor(); });
}

void MainComponent::closePluginEditor()
{
    pluginWindow.reset();
}

// ---- macOS menu bar ----------------------------------------------------------
void MainComponent::buildMenus()
{
    menus = {
        { "File", {
            { "New Guitar",        "new:guitar" },
            { "New Bass",          "new:bass" },
            { "New Drums",         "new:drums" },
            { "New Full Band",     "new:band" },
            { "-", "" },
            { "Open... (.gp / .gomidas / MusicXML)", "open" },
            { "Save...",        "save" },
            { "Export Guitar Pro (.gp)...", "exportgp" },
            { "Print...",          "print" },
            { "-", "" },
            { "Load Sample",       "sample" },
        } },
        { "Edit", {
            { "Undo",  "undo" },
            { "Redo",  "redo" },
            { "-", "" },
            { "Cut",   "cut" },
            { "Copy",  "copy" },
            { "Paste", "paste" },
            { "-", "" },
            { "Select All", "selectall" },
        } },
        { "Track", {
            { "Add Guitar Track", "addtrack:guitar" },
            { "Add Bass Track",   "addtrack:bass" },
            { "Add Drum Track",   "addtrack:drums" },
            { "-", "" },
            { "Delete Track", "deletetrack" },
        } },
        { "Bar", {
            { "Insert Bar", "addbar" },
            { "Delete Bar", "deletebar" },
            { "-", "" },
            { "Time Signature...", "timesig" },
            { "Key Signature...",  "keysig" },
            { "-", "" },
            { "Open Repeat",  "repeatstart" },
            { "Close Repeat", "repeatend" },
        } },
        { "Note", {
            { "Whole",      "dur:1" },
            { "Half",       "dur:2" },
            { "Quarter",    "dur:4" },
            { "Eighth",     "dur:8" },
            { "Sixteenth",  "dur:16" },
            { "Thirty-second", "dur:32" },
            { "-", "" },
            { "Triplet (3)", "tuplet:3" },
            { "Quintuplet (5)", "tuplet:5" },
            { "Sextuplet (6)",  "tuplet:6" },
            { "Septuplet (7)",  "tuplet:7" },
            { "Nonuplet (9)",   "tuplet:9" },
            { "Triplet Feel (swing)", "tripletfeel" },
            { "-", "" },
            { "Dotted",     "dot" },
            { "Tie",        "tie" },
            { "Rest",       "rest" },
            { "Dead Note",  "dead" },
            { "-", "" },
            { "Voice 1", "voice:1" },
            { "Voice 2", "voice:2" },
            { "Voice 3", "voice:3" },
            { "Voice 4", "voice:4" },
            { "-", "" },
            { "Text...",    "text" },
            { "Chord...",   "chord" },
        } },
        { "Effects", {
            { "Bend...",          "bend" },
            { "-", "" },
            { "Palm Mute",        "fx:palmmute" },
            { "Let Ring",         "fx:letring" },
            { "Hammer-on / Pull-off", "fx:hammer" },
            { "Slide",            "fx:slide" },
            { "Ghost Note",       "fx:ghost" },
            { "Staccato",         "fx:staccato" },
            { "Accent",           "fx:accent" },
            { "Natural Harmonic", "fx:harmonic" },
            { "Artificial Harmonic", "fx:artharmonic" },
            { "Pinch Harmonic",   "fx:pinchharmonic" },
            { "Vibrato",          "fx:vibrato" },
            { "Wide Vibrato",     "fx:widevibrato" },
            { "-", "" },
            { "Shift Slide",      "fx:shiftslide" },
            { "Pick Slide Down",  "fx:pickslidedown" },
            { "Pick Slide Up",    "fx:pickslideup" },
            { "-", "" },
            { "Brush Up",         "fx:brushup" },
            { "Brush Down",       "fx:brushdown" },
            { "Arpeggio Up",      "fx:arpup" },
            { "Arpeggio Down",    "fx:arpdown" },
            { "Pick Stroke Up",   "fx:pickup" },
            { "Pick Stroke Down", "fx:pickdown" },
            { "-", "" },
            { "Tremolo Picking",  "fx:tremolo" },
            { "Trill",            "fx:trill" },
            { "Grace Note (before)", "fx:grace" },
            { "Grace Note (on beat)", "fx:graceon" },
            { "Slap",             "fx:slap" },
            { "Pop",              "fx:pop" },
            { "-", "" },
            { "Fade In",          "fx:fadein" },
            { "Fade Out",         "fx:fadeout" },
            { "Volume Swell",     "fx:swell" },
            { "-", "" },
            { "Tremolo Bar",      "fx:tremolobar" },
            { "Wah Open",         "fx:wahopen" },
            { "Wah Closed",       "fx:wahclosed" },
            { "Rasgueado",        "fx:rasgueado" },
            { "Left-Hand Tapping", "fx:lefthandtap" },
            { "Tapping",          "fx:tap" },
        } },
        { "Section", {
            { "Segno", "dir:TargetSegno" },
            { "Coda",  "dir:TargetCoda" },
            { "Fine",  "dir:TargetFine" },
            { "-", "" },
            { "Da Capo",          "dir:JumpDaCapo" },
            { "Da Capo al Fine",  "dir:JumpDaCapoAlFine" },
            { "Dal Segno",        "dir:JumpDalSegno" },
            { "Dal Segno al Coda", "dir:JumpDalSegnoAlCoda" },
            { "-", "" },
            { "Fermata", "fermata" },
        } },
        { "Tools", {
            { "Transpose...", "transpose" },
            { "-", "" },
            { "Metronome (toggle)", "metronome" },
            { "Count-in (toggle)",  "countin" },
            { "Panic (All Notes Off)", "panic" },
        } },
        { "Sound", {
            { "Play / Stop", "play" },
            { "Panic (All Notes Off)", "panic" },
            { "-", "" },
            { "Loop Selection", "loopsel" },
            { "Clear Loop",     "loopclear" },
            { "-", "" },
            { "Metronome (toggle)", "metronome" },
            { "Count-in (toggle)",  "countin" },
            { "-", "" },
            { "Live Input Monitor (toggle)", "liveinput" },
            { "Load Input Plugin (AU/VST3)...", "loadplugin" },
            { "Show Plugin Editor", "showplugineditor" },
            { "Clear Input Plugin", "clearplugin" },
            { "-", "" },
            { "Load SFZ Instrument for Track...", "loadsfz" },
            { "Clear SFZ Instrument for Track", "clearsfz" },
            { "-", "" },
            { "Record to WAV (toggle)...", "record" },
        } },
        { "View", {
            { "Zoom In",  "zoom:in" },
            { "Zoom Out", "zoom:out" },
            { "-", "" },
            { "Toggle Multitrack View", "toggleview" },
            { "Toggle Beat Grid", "togglebeatgrid" },
            { "Go To Bar...", "gotobar" },
            { "-", "" },
            { "Toggle Left Palette", "toggle:palette" },
            { "Toggle Right Inspector", "toggle:inspector" },
            { "Toggle Track List", "toggle:tracks" },
            { "Full View", "fullscore" },
        } },
        { "Window", { { "Minimize", "minimize" } } },
        { "Help",   { { "About Gomidas", "about" } } },
    };

    menuIds = {};
    for (auto& m : menus)
        for (auto& it : m.second)
            if (it.label != "-")
                it.id = menuIds.add ({ MenuCommand::Kind::action, it.action });
    menuIds.freeze();
}

void MainComponent::runMenuAction (const juce::String& action)
{
    if (webView != nullptr && action.isNotEmpty())
        webView->evaluateJavascript ("window.gomidasMenu && window.gomidasMenu("
                                     + juce::JSON::toString (juce::var (action)) + ");");
}

// ---- open + recent files -----------------------------------------------------
juce::File MainComponent::recentStoreFile() const
{
    auto base = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory);
   #if JUCE_MAC
    // userApplicationDataDirectory is ~/Library on macOS, so add "Application Support". Existing
    // users' lists live here — never move it.
    base = base.getChildFile ("Application Support");
   #endif
    // Elsewhere it already is the per-user config dir: ~/.config on Linux, %APPDATA% on Windows
    // (GOM-88 — it used to grow a literal "Application Support" folder there).
    return base.getChildFile ("Gomidas").getChildFile ("recent.txt");
}

#if ! JUCE_MAC
// Where the VST3 SDK says plugins live (Linux: per-user first, then system-wide); home if none exists.
juce::File MainComponent::defaultVst3Dir()
{
   #if JUCE_WINDOWS
    const juce::File candidates[] = {
        juce::File::getSpecialLocation (juce::File::globalApplicationsDirectory)
            .getChildFile ("Common Files").getChildFile ("VST3") };
   #else
    const juce::File candidates[] = {
        juce::File::getSpecialLocation (juce::File::userHomeDirectory).getChildFile (".vst3"),
        juce::File ("/usr/lib/vst3"),
        juce::File ("/usr/local/lib/vst3") };
   #endif
    for (const auto& dir : candidates)
        if (dir.isDirectory())
            return dir;
    return juce::File::getSpecialLocation (juce::File::userHomeDirectory);
}
#endif

// The one Clear Recent, for both the macOS submenu and the page's HTML menu (GOM-86).
void MainComponent::clearRecentFiles()
{
    recentFiles.clear();
    saveRecentList();
    pushRecentFiles();
}

#if ! JUCE_MAC
// One-time move (GOM-88): before it, non-macOS builds kept the list under a literal
// "<config>/Application Support/Gomidas/recent.txt". Copied VERBATIM — loadRecentList drops entries
// that don't exist right now (an unmounted drive), and the old file is the only copy. Then the old
// file goes, and its two folders only if EMPTY (deleteFile on a directory is rmdir) and never a
// symlink, since deleteFile would remove the link itself.
void MainComponent::migrateLegacyRecentList() const
{
    const auto target = recentStoreFile();
    const auto legacy = juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                            .getChildFile ("Application Support").getChildFile ("Gomidas").getChildFile ("recent.txt");
    if (target.existsAsFile() || ! legacy.existsAsFile())
        return;
    target.getParentDirectory().createDirectory();
    if (! legacy.copyFileTo (target) || ! legacy.deleteFile())
        return;
    const auto gomidasDir = legacy.getParentDirectory();
    for (const auto& dir : { gomidasDir, gomidasDir.getParentDirectory() })
        if (dir.isSymbolicLink() || ! dir.deleteFile())
            break;
}
#endif

void MainComponent::loadRecentList()
{
   #if ! JUCE_MAC
    migrateLegacyRecentList();
   #endif
    recentFiles.clear();
    auto f = recentStoreFile();
    if (! f.existsAsFile()) return;
    juce::StringArray lines;
    f.readLines (lines);
    for (auto& line : lines)
    {
        auto p = line.trim();
        if (p.isEmpty() || ! juce::File::isAbsolutePath (p))   // juce::File asserts on relative paths
            continue;
        p = juce::File (p).getFullPathName();   // normalised, so removeString finds it later
        if (juce::File (p).existsAsFile() && ! recentFiles.contains (p))
            recentFiles.add (p);
    }
    while (recentFiles.size() > kRecentMax) recentFiles.remove (recentFiles.size() - 1);
}

void MainComponent::saveRecentList() const
{
    auto f = recentStoreFile();
    f.getParentDirectory().createDirectory();
    f.replaceWithText (recentFiles.joinIntoString ("\n"));
}

void MainComponent::addRecent (const juce::File& file)
{
    auto p = file.getFullPathName();
    recentFiles.removeString (p);
    recentFiles.insert (0, p);
    while (recentFiles.size() > kRecentMax) recentFiles.remove (recentFiles.size() - 1);
    saveRecentList();
    pushRecentFiles();
}

// Hand the page's HTML menu {name, path} pairs; the name comes from juce::File so the page never
// guesses at path syntax. macOS has the native submenu and never draws the HTML one.
void MainComponent::pushRecentFiles()
{
    if (kNativeMenus || webView == nullptr)
        return;
    juce::Array<juce::var> entries;
    for (const auto& path : recentFiles)
    {
        auto* entry = new juce::DynamicObject();
        entry->setProperty ("name", juce::File (path).getFileName());
        entry->setProperty ("path", path);
        entries.add (juce::var (entry));
    }
    webView->evaluateJavascript ("window.gomidasRecentFiles && window.gomidasRecentFiles("
                                 + juce::JSON::toString (juce::var (entries), true) + ");");
}

void MainComponent::loadFileFromPath (const juce::File& f)
{
    if (webView == nullptr) return;
    if (! f.existsAsFile())
    {
        recentFiles.removeString (f.getFullPathName());
        saveRecentList();
        pushRecentFiles();
        juce::NativeMessageBox::showMessageBoxAsync (juce::MessageBoxIconType::WarningIcon, "Gomidas",
            f.getFileName() + " could not be found - it may have been moved or deleted.", this);
        return;
    }

    if (f.hasFileExtension ("gomidas"))
    {
        auto content = f.loadFileAsString();
        auto literal = juce::JSON::toString (juce::var (content));
        webView->evaluateJavascript ("window.gomidasLoadProject(" + literal + ");");
    }
    else
    {
        // Guitar Pro / MusicXML: hand the raw bytes to alphaTab as base64.
        juce::MemoryBlock mb;
        if (! f.loadFileAsData (mb))
        {
            juce::NativeMessageBox::showMessageBoxAsync (juce::MessageBoxIconType::WarningIcon, "Gomidas",
                f.getFileName() + " could not be read.", this);
            return;
        }
        auto b64 = juce::Base64::toBase64 (mb.getData(), mb.getSize());
        webView->evaluateJavascript ("window.gomidasLoadBinary(" + juce::JSON::toString (juce::var (b64)) + ");");
    }
    addRecent (f);
}

void MainComponent::openFileDialog()
{
    auto chooser = std::make_shared<juce::FileChooser> (
        "Open a tab",
        juce::File::getSpecialLocation (juce::File::userMusicDirectory),
        "*.gp;*.gp3;*.gp4;*.gp5;*.gpx;*.gp7;*.gp8;*.gomidas;*.xml;*.musicxml;*.mxl");
    chooser->launchAsync (juce::FileBrowserComponent::openMode
                          | juce::FileBrowserComponent::canSelectFiles,
        [this, chooser] (const juce::FileChooser& fc)
        {
            auto f = fc.getResult();
            if (f.existsAsFile())
                loadFileFromPath (f);
        });
}

juce::StringArray MainComponent::getMenuBarNames()
{
    juce::StringArray names;
    for (const auto& m : menus) names.add (m.first);
    return names;
}

juce::PopupMenu MainComponent::getMenuForIndex (int topLevelMenuIndex, const juce::String&)
{
    juce::PopupMenu menu;
    if (topLevelMenuIndex < 0 || topLevelMenuIndex >= (int) menus.size())
        return menu;

    const auto& items = menus[(size_t) topLevelMenuIndex].second;
    for (int j = 0; j < (int) items.size(); ++j)
    {
        const auto& it = items[(size_t) j];
        if (it.label == "-") { menu.addSeparator(); continue; }
        menu.addItem (it.id, it.label, it.action.isNotEmpty(), false);

        // Tuck the "Open Recent" submenu in right after the File → Open item.
        if (it.action == "open")
        {
            // Each entry's id carries the path it shows, so a click opens that file even if the
            // list has changed since (GOM-102) — by path, never position.
            menuIds.clearDynamic();
            juce::PopupMenu recent;
            if (recentFiles.isEmpty())
                recent.addItem (menuIds.add ({ MenuCommand::Kind::action, {} }), "(no recent files)", false, false);
            else
            {
                for (const auto& path : recentFiles)
                    recent.addItem (menuIds.add ({ MenuCommand::Kind::openRecent, path }),
                                    juce::File (path).getFileName(), true, false);
                recent.addSeparator();
                recent.addItem (menuIds.add ({ MenuCommand::Kind::clearRecent, {} }), "Clear Recent", true, false);
            }
            menu.addSubMenu ("Open Recent", recent);
        }
    }
    return menu;
}

void MainComponent::menuItemSelected (int menuItemID, int)
{
    const auto* cmd = menuIds.find (menuItemID);
    if (cmd == nullptr)
        return;
    switch (cmd->kind)
    {
        case MenuCommand::Kind::action:
            if (cmd->value.isNotEmpty())
                runMenuAction (cmd->value);
            break;
        case MenuCommand::Kind::openRecent:
            // Route through JS so the unsaved-changes guard runs first; native openRecent then
            // opens it only if it is still in the list.
            if (webView != nullptr)
                webView->evaluateJavascript ("window.gomidasConfirmOpenRecent("
                                             + juce::JSON::toString (juce::var (cmd->value)) + ");");
            break;
        case MenuCommand::Kind::clearRecent:
            clearRecentFiles();
            break;
    }
}

std::optional<juce::WebBrowserComponent::Resource>
MainComponent::serveResource (const juce::String& url)
{
    // url is the path part (e.g. "/app.js"); strip any query string.
    auto path = url.upToFirstOccurrenceOf ("?", false, false);

    for (const auto& a : kAssets)
    {
        if (path == a.path)
        {
            int size = 0;
            if (const char* data = GomidasAssets::getNamedResource (a.resource, size))
            {
                // WebKitGTK needs a BOM on UTF-8 text assets — see AssetBytes.h (GOM-90).
                return juce::WebBrowserComponent::Resource { assetBytes (data, (size_t) size, a.mime, kWebViewNeedsUtf8Bom),
                                                             juce::String (a.mime) };
            }
        }
    }
    std::cerr << "[res] MISS " << path << std::endl;
    return std::nullopt;
}

void MainComponent::handleSetSequence (const juce::var& payload)
{
    // payload = { "lengthTicks": <num>, "events": [[tick,channel,key,vel,on,program,perc], ...] }
    auto seq = new Sequence();

    if (auto* obj = payload.getDynamicObject())
    {
        seq->lengthTicks = (double) obj->getProperty ("lengthTicks");

        if (auto* arr = obj->getProperty ("events").getArray())
        {
            seq->events.reserve ((size_t) arr->size());
            for (const auto& e : *arr)
            {
                if (auto* ev = e.getArray(); ev != nullptr && ev->size() >= 7)
                {
                    NoteEvent n;
                    n.tick       = (double) (*ev)[0];
                    n.channel    = (int)    (*ev)[1];
                    n.key        = (int)    (*ev)[2];
                    n.velocity   = (float)  (double) (*ev)[3];
                    n.on         = (bool)   (*ev)[4];
                    n.program    = (int)    (*ev)[5];
                    n.percussion = (bool)   (*ev)[6];
                    // Optional 8th/9th elements: kind + value (pitch-bend / CC). Absent = note.
                    if (ev->size() >= 9)
                    {
                        n.kind  = (int) (*ev)[7];
                        n.value = (int) (*ev)[8];
                    }
                    seq->events.push_back (n);
                }
            }
        }
    }

    // buildSequence already delivers this stably tick-sorted; re-sorting here is belt-and-braces
    // (and keeps older/hand-built payloads honest). STABLE, because equal-tick order carries
    // meaning: a note-on precedes the bend points at the same tick, and a note-off at tick T
    // precedes the next note-on at T. std::sort would be free to permute those.
    std::stable_sort (seq->events.begin(), seq->events.end(),
                      [] (const NoteEvent& a, const NoteEvent& b) { return a.tick < b.tick; });

    engine.setSequence (Sequence::Ptr (seq));
}

void MainComponent::timerCallback()
{
    // Only push into the WebView while playing or monitoring — doing it 30x/sec when
    // idle starves editing/rendering and makes input lag.
    if (webView == nullptr || ! (engine.isPlaying() || engine.isLiveInput()))
        return;

    if (engine.isPlaying())
    {
        const double ticks = engine.getPositionTicks();
        if (std::abs (ticks - lastPushedTicks) >= 1.0)
        {
            lastPushedTicks = ticks;
            webView->evaluateJavascript ("window.gomidas && window.gomidas.onTick("
                                         + juce::String (ticks, 1) + ");");
        }
    }
    // Output level meter (peak 0..1).
    webView->evaluateJavascript ("window.gomidasMeter && window.gomidasMeter("
                                 + juce::String (engine.getOutputPeak(), 4) + ");");
}

void MainComponent::resized()
{
    if (webView != nullptr)
        webView->setBounds (getLocalBounds());
}

void MainComponent::paint (juce::Graphics& g)
{
    g.fillAll (juce::Colour (0xff1b1b1f));
}

bool MainComponent::keyPressed (const juce::KeyPress& key)
{
    if (webView == nullptr)
        return false;

    // Map the JUCE key to the JS key name the editor expects.
    // Compare KEY CODES: KeyPress::operator==(int) only matches with no modifier held, which
    // dropped every Ctrl/Alt + named-key shortcut (Ctrl+Ins, Ctrl+Del, Alt+arrows) on this path.
    const int code = key.getKeyCode();
    juce::String jsKey;
    if (code == juce::KeyPress::leftKey)          jsKey = "ArrowLeft";
    else if (code == juce::KeyPress::rightKey)    jsKey = "ArrowRight";
    else if (code == juce::KeyPress::upKey)       jsKey = "ArrowUp";
    else if (code == juce::KeyPress::downKey)     jsKey = "ArrowDown";
    else if (code == juce::KeyPress::pageUpKey)   jsKey = "PageUp";
    else if (code == juce::KeyPress::pageDownKey) jsKey = "PageDown";
    else if (code == juce::KeyPress::returnKey)   jsKey = "Enter";
    else if (code == juce::KeyPress::backspaceKey) jsKey = "Backspace";
    else if (code == juce::KeyPress::deleteKey)   jsKey = "Delete";
    else if (code == juce::KeyPress::homeKey)     jsKey = "Home";
    else if (code == juce::KeyPress::endKey)      jsKey = "End";
    else if (code == juce::KeyPress::tabKey)      jsKey = "Tab";
    else if (code == juce::KeyPress::F3Key)       jsKey = "F3";
    else if (code == juce::KeyPress::spaceKey)    jsKey = " ";
    else if (code == juce::KeyPress::insertKey)   jsKey = "Insert";   // GP8 Windows: Ins = Insert Bar
    else
    {
        auto c = key.getTextCharacter();
        // Ctrl/Alt turn a letter into a control character (Ctrl+Z -> 0x1A on X11) or into nothing
        // (Windows); the key code still names the key, so use it for a printable one (GOM-87).
        // Only under Ctrl: a key that genuinely types a control character (Escape) is forwarded as
        // before, and a macOS ⌥ dead key (⌥E -> no character) is not turned into a letter.
        if (c < 0x20 && key.getModifiers().isCtrlDown() && code >= 0x20 && code < 0x7f)
            c = (juce::juce_wchar) code;
        if (c == 0) return false;
        jsKey = juce::String::charToString (c);
    }

    // Send Command (⌘) and Control (⌃) separately — Guitar Pro maps different actions to each
    // (⌘+ = Insert Bar, ⌃+ = Insert Beat). Off macOS JUCE reports Ctrl as Command too
    // (commandModifier == ctrlModifier), so there "meta" is never set and Ctrl arrives as ctrl;
    // core/keymap.ts then applies GP8's Windows keymap (GOM-87).
   #if JUCE_MAC
    const bool cmd   = key.getModifiers().isCommandDown();
   #else
    const bool cmd   = false;
   #endif
    const bool ctrl  = key.getModifiers().isCtrlDown();
    const bool shift = key.getModifiers().isShiftDown();
    const bool alt   = key.getModifiers().isAltDown();
    webView->evaluateJavascript ("window.gomidasNativeKey(" + juce::JSON::toString (juce::var (jsKey))
                                 + "," + (cmd ? "true" : "false")
                                 + "," + (ctrl ? "true" : "false")
                                 + "," + (shift ? "true" : "false")
                                 + "," + (alt ? "true" : "false") + ");");
    return true;
}
} // namespace gomidas
