#include <juce_gui_extra/juce_gui_extra.h>
#include "ui/MainComponent.h"
#include "ui/X11WindowBounds.h"

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
            startBoundsSync();
           #endif
        }

       #if JUCE_LINUX || JUCE_BSD
        // A tiling window manager (Hyprland, i3, … via XWayland) resizes the window as it maps it,
        // and JUCE can miss that ConfigureNotify: the X window has the tile's bounds while the
        // content stays at its initial 1280x820, clipped or letterboxed (GOM-91). Later resizes
        // arrive normally, so after each map, briefly compare JUCE's bounds with the X server's
        // and adopt the real ones once — only after two identical reads, so a resize the user is
        // making right then is never fought, and with a 1 px tolerance for scale rounding.
        void visibilityChanged() override
        {
            DocumentWindow::visibilityChanged();
            if (isVisible())
                startBoundsSync();
        }

        void startBoundsSync()
        {
            syncTicks = 0;
            lastRead.reset();
            startTimer (kSyncIntervalMs);
        }

        void timerCallback() override
        {
            if (++syncTicks * kSyncIntervalMs >= kSyncWindowMs)
                stopTimer();

            auto* peer = getPeer();
            const auto real = peer != nullptr ? realPeerBounds (*peer) : std::nullopt;
            if (! real.has_value())
                return;

            const bool stable = lastRead.has_value() && *lastRead == *real;
            lastRead = real;
            if (! stable)
                return;

            const auto current = peer->getBounds();
            auto differs = [] (int a, int b) { return std::abs (a - b) > 1; };
            if (differs (real->getX(), current.getX()) || differs (real->getY(), current.getY())
                || differs (real->getWidth(), current.getWidth()) || differs (real->getHeight(), current.getHeight()))
            {
                peer->setBounds (*real, false);   // updates the component; the X request equals the real bounds
                stopTimer();
            }
        }

        static constexpr int kSyncIntervalMs = 200;
        static constexpr int kSyncWindowMs   = 3000;
        int syncTicks = 0;
        std::optional<juce::Rectangle<int>> lastRead;
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
