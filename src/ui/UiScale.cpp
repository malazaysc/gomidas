#include "UiScale.h"
#include <juce_gui_basics/juce_gui_basics.h>
#include <iostream>

namespace gomidas
{
void applyUiScale()
{
   #if JUCE_LINUX || JUCE_BSD
    auto& desktop = juce::Desktop::getInstance();
    const auto* display = desktop.getDisplays().getPrimaryDisplay();
    if (display == nullptr)
        return;

    // JUCE's own per-display scale, without whatever global factor is already applied.
    const auto globalNow = (double) desktop.getGlobalScaleFactor();
    const auto detected = globalNow > 0 ? display->scale / globalNow : display->scale;
    const auto physical = display->totalArea.toDouble() * display->scale;   // logical -> physical px

    const char* overrideValue = std::getenv ("GOMIDAS_SCALE");
    const auto choice = chooseUiScale (display->dpi, detected,
                                       juce::roundToInt (physical.getWidth()), juce::roundToInt (physical.getHeight()),
                                       overrideValue);

    // JUCE: Display::scale is (JUCE's per-display scale) x (global factor). Set the global factor
    // so the product is the chosen scale.
    if (detected > 0)
        desktop.setGlobalScaleFactor ((float) (choice.scale / detected));

    // GTK (the WebKit view): integer device scale. GDK_DPI_SCALE is left alone — on classic HiDPI
    // X11 setups it compensates Xft.dpi, and clearing it would double the text size.
    ::setenv ("GDK_SCALE", juce::String (choice.scale).toRawUTF8(), 1);

    const char* source = choice.source == UiScaleChoice::Source::override       ? "GOMIDAS_SCALE"
                       : choice.source == UiScaleChoice::Source::desktopSetting ? "desktop setting"
                                                                                : "display dpi";
    std::cerr << "[Gomidas] UI scale " << choice.scale << " (" << source << "; display "
              << juce::roundToInt (display->dpi) << " dpi, " << juce::roundToInt (physical.getWidth())
              << "x" << juce::roundToInt (physical.getHeight()) << " px)" << std::endl;
    if (choice.overrideRejected)
        std::cerr << "[Gomidas] ignored GOMIDAS_SCALE=" << overrideValue << " (expected an integer 1-4)" << std::endl;
   #endif
}
}
