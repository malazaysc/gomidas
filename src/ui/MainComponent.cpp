#include "MainComponent.h"
#include "GomidasAssets.h"

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
    { "/dist/core/webaudio.js", "webaudio_js",  "text/javascript" },
    { "/dist/app.js",    "app_js",          "text/javascript" },
    { "/dist/editor.js", "editor_js",       "text/javascript" },
    { "/dist/fretboard.js", "fretboard_js", "text/javascript" },
    { "/dist/grooves.js", "grooves_js",     "text/javascript" },
    { "/juce_native_interop.js", "juce_native_interop_js", "text/javascript" },
    { "/alphaTab.min.js","alphaTab_min_js", "text/javascript" },
    { "/Bravura.woff2",  "Bravura_woff2",   "font/woff2" },
    { "/Bravura.woff",   "Bravura_woff",    "font/woff" },
    { "/drumkit.png",    "drumkit_png",     "image/png" },
};
} // namespace

MainComponent::MainComponent()
{
    engine.initialise();

    // ---- web view hosting alphaTab (owns the whole UI: toolbar, editor, fretboard) ----
    auto options = juce::WebBrowserComponent::Options{}
        .withNativeIntegrationEnabled()
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
                auto start = juce::File ("/Library/Audio/Plug-Ins");
                auto chooser = std::make_shared<juce::FileChooser> (
                    "Choose an AU (.component) or VST3 (.vst3) plugin", start, "*.vst3;*.component");
                chooser->launchAsync (juce::FileBrowserComponent::openMode
                                      | juce::FileBrowserComponent::canSelectFiles
                                      | juce::FileBrowserComponent::canSelectDirectories,
                    [this, chooser] (const juce::FileChooser& fc)
                    {
                        auto f = fc.getResult();
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
                // Built-in instruments live in Gomidas.app/Contents/Resources/instruments.
                auto appFile = juce::File::getSpecialLocation (juce::File::currentApplicationFile);
                auto f = appFile.getChildFile ("Contents/Resources/instruments").getChildFile (rel);
                const bool ok = f.existsAsFile() && engine.loadChannelSfz (channel, f);
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
                if (! args.isEmpty())
                {
                    const int i = (int) args[0];
                    if (i >= 0 && i < recentFiles.size())
                        loadFileFromPath (juce::File (recentFiles[i]));
                }
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
    juce::MenuBarModel::setMacMainMenu (this);

    setSize (1280, 820);
    startTimerHz (30);
}

MainComponent::~MainComponent()
{
    juce::MenuBarModel::setMacMainMenu (nullptr);
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
    // macOS: userApplicationDataDirectory == ~/Library, so add "Application Support".
    return juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
               .getChildFile ("Application Support")
               .getChildFile ("Gomidas")
               .getChildFile ("recent.txt");
}

void MainComponent::loadRecentList()
{
    recentFiles.clear();
    auto f = recentStoreFile();
    if (! f.existsAsFile()) return;
    juce::StringArray lines;
    f.readLines (lines);
    for (auto& line : lines)
    {
        auto p = line.trim();
        if (p.isNotEmpty() && juce::File (p).existsAsFile() && ! recentFiles.contains (p))
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
}

void MainComponent::loadFileFromPath (const juce::File& f)
{
    if (webView == nullptr) return;
    if (! f.existsAsFile())
    {
        recentFiles.removeString (f.getFullPathName());
        saveRecentList();
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
        if (! f.loadFileAsData (mb)) return;
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
        const int id = (topLevelMenuIndex + 1) * 1000 + (j + 1);
        menu.addItem (id, it.label, it.action.isNotEmpty(), false);

        // Tuck the "Open Recent" submenu in right after the File → Open item.
        if (it.action == "open")
        {
            juce::PopupMenu recent;
            if (recentFiles.isEmpty())
                recent.addItem (kRecentIdBase + kRecentMax + 1, "(no recent files)", false, false);
            else
            {
                for (int r = 0; r < recentFiles.size(); ++r)
                    recent.addItem (kRecentIdBase + r, juce::File (recentFiles[r]).getFileName(), true, false);
                recent.addSeparator();
                recent.addItem (kRecentIdBase + kRecentMax + 2, "Clear Recent", true, false);
            }
            menu.addSubMenu ("Open Recent", recent);
        }
    }
    return menu;
}

void MainComponent::menuItemSelected (int menuItemID, int)
{
    // Recent-files range (and Clear Recent) live above kRecentIdBase.
    if (menuItemID >= kRecentIdBase)
    {
        if (menuItemID == kRecentIdBase + kRecentMax + 2) // Clear Recent
        {
            recentFiles.clear();
            saveRecentList();
            return;
        }
        const int idx = menuItemID - kRecentIdBase;
        if (idx >= 0 && idx < recentFiles.size() && webView != nullptr)
            // Route through JS so the unsaved-changes guard runs first.
            webView->evaluateJavascript ("window.gomidasConfirmOpenRecent("
                                         + juce::String (idx) + ");");
        return;
    }

    const int top = menuItemID / 1000 - 1;
    const int item = menuItemID % 1000 - 1;
    if (top >= 0 && top < (int) menus.size()
        && item >= 0 && item < (int) menus[(size_t) top].second.size())
        runMenuAction (menus[(size_t) top].second[(size_t) item].action);
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
                std::vector<std::byte> bytes ((size_t) size);
                std::memcpy (bytes.data(), data, (size_t) size);
                return juce::WebBrowserComponent::Resource { std::move (bytes), juce::String (a.mime) };
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

    std::sort (seq->events.begin(), seq->events.end(),
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
    juce::String jsKey;
    if (key == juce::KeyPress::leftKey)        jsKey = "ArrowLeft";
    else if (key == juce::KeyPress::rightKey)  jsKey = "ArrowRight";
    else if (key == juce::KeyPress::upKey)     jsKey = "ArrowUp";
    else if (key == juce::KeyPress::downKey)   jsKey = "ArrowDown";
    else if (key == juce::KeyPress::pageUpKey) jsKey = "PageUp";
    else if (key == juce::KeyPress::pageDownKey) jsKey = "PageDown";
    else if (key == juce::KeyPress::returnKey) jsKey = "Enter";
    else if (key == juce::KeyPress::backspaceKey) jsKey = "Backspace";
    else if (key == juce::KeyPress::deleteKey) jsKey = "Delete";
    else if (key == juce::KeyPress::homeKey)   jsKey = "Home";
    else if (key == juce::KeyPress::endKey)    jsKey = "End";
    else if (key == juce::KeyPress::tabKey)    jsKey = "Tab";
    else if (key == juce::KeyPress::F3Key)     jsKey = "F3";
    else if (key == juce::KeyPress::spaceKey)  jsKey = " ";
    else
    {
        const auto c = key.getTextCharacter();
        if (c == 0) return false;
        jsKey = juce::String::charToString (c);
    }

    // Send Command (⌘) and Control (⌃) separately — Guitar Pro maps different
    // actions to each (⌘+ = Insert Bar, ⌃+ = Insert Beat).
    const bool cmd   = key.getModifiers().isCommandDown();
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
