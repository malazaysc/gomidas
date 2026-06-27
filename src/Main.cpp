#include <juce_gui_extra/juce_gui_extra.h>
#include "ui/MainComponent.h"

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
            setResizeLimits (900, 600, 4000, 2600);
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
};
} // namespace gomidas

START_JUCE_APPLICATION (gomidas::GomidasApplication)
