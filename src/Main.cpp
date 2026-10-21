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
        applyUiScale();   // Linux: before the web view exists, so GTK and JUCE agree (GOM-92)
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
            setResizeLimits (kMinWindowWidth, kMinWindowHeight, 4000, 2600);   // UiScale.h fits the scale to this
            centreWithSize (getWidth(), getHeight());
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
