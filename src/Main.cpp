#include <juce_gui_extra/juce_gui_extra.h>
#include "ui/MainComponent.h"
#include "ui/X11EventWake.h"
#include "ui/UiScale.h"

namespace gomidas
{
class GomidasApplication : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override    { return "Gomidas"; }
    const juce::String getApplicationVersion() override { return "0.1.0"; }
    bool moreThanOneInstanceAllowed() override          { return false; }

    void initialise (const juce::String&) override
    {
        // Linux: one UI scale for JUCE and the WebKit view (GOM-92). Must run before the window is
        // built (the WebKit child is forked then) and before any thread starts (it sets GDK_SCALE).
        applyUiScale();
        mainWindow = std::make_unique<MainWindow> ("Gomidas");
    }

    void shutdown() override { mainWindow = nullptr; }

    void systemRequestedQuit() override { quit(); }

    class MainWindow final : public juce::DocumentWindow
    {
    public:
        explicit MainWindow (juce::String name)
            : juce::DocumentWindow (name,
                                    juce::Colour (0xff1b1b1f),
                                    juce::DocumentWindow::allButtons)
        {
            setUsingNativeTitleBar (true);
            setContentOwned (new MainComponent(), true);
            setResizable (true, true);

            // At a large desktop scale the logical screen can be smaller than the window's usual
            // minimum or initial size (200% on 1080p is 960x540): fit both to the usable area.
            auto usable = juce::Rectangle<int> (4000, 2600);
            if (const auto* display = juce::Desktop::getInstance().getDisplays().getPrimaryDisplay())
                usable = display->userArea;
            setResizeLimits (juce::jmin (900, usable.getWidth()), juce::jmin (600, usable.getHeight()), 4000, 2600);
            centreWithSize (juce::jmin (getWidth(), usable.getWidth()), juce::jmin (getHeight(), usable.getHeight()));
            setVisible (true);
        }

        void closeButtonPressed() override
        {
            JUCEApplication::getInstance()->systemRequestedQuit();
        }

    private:
        JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (MainWindow)
    };

private:
    std::unique_ptr<MainWindow> mainWindow;
   #if JUCE_LINUX || JUCE_BSD
    X11EventWake x11EventWake;   // wake JUCE for X events stranded in Xlib's queue (GOM-91)
   #endif
};
} // namespace gomidas

START_JUCE_APPLICATION (gomidas::GomidasApplication)
