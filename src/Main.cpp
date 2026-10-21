#include <juce_gui_extra/juce_gui_extra.h>
#include "ui/MainComponent.h"
#if JUCE_LINUX || JUCE_BSD
 #include "platform/X11WindowSize.h"
#endif

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
                          #if JUCE_LINUX || JUCE_BSD
                           , private juce::Timer
                          #endif
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

           #if JUCE_LINUX || JUCE_BSD
            startTimer (kSizeSyncIntervalMs);
           #endif
        }

       #if JUCE_LINUX || JUCE_BSD
        // A tiling window manager (Hyprland, i3, … via XWayland) resizes the window as it maps it,
        // and JUCE can miss that first ConfigureNotify: the X window has the tile's size while the
        // content stays at its initial 1280x820, clipped or letterboxed (GOM-91). Later resizes are
        // delivered fine, so for the first few seconds read the real size from the X server and
        // adopt it if JUCE disagrees.
        void timerCallback() override
        {
            if (++sizeSyncTicks * kSizeSyncIntervalMs >= kSizeSyncWindowMs)
                stopTimer();

            auto* peer = getPeer();
            int w = 0, h = 0;
            if (peer == nullptr || ! queryX11WindowSize (peer->getNativeHandle(), w, h))
                return;

            const auto scale = peer->getPlatformScaleFactor();
            const auto logical = juce::Rectangle<double> (w, h) / (scale > 0 ? scale : 1.0);
            const auto size = logical.toNearestInt();
            if (size.getWidth() > 0 && size.getHeight() > 0 && (size.getWidth() != getWidth() || size.getHeight() != getHeight()))
                setSize (size.getWidth(), size.getHeight());
        }

        static constexpr int kSizeSyncIntervalMs = 200;
        static constexpr int kSizeSyncWindowMs   = 3000;
        int sizeSyncTicks = 0;
       #endif

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
