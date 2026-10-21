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

    const int scale = chooseUiScale (display->dpi, std::getenv ("GOMIDAS_SCALE"));

    // JUCE: Display::scale is (JUCE's own per-display scale) x (global factor). Set the global
    // factor so the product is `scale`, whatever JUCE detected on its own.
    const auto globalNow = (double) desktop.getGlobalScaleFactor();
    const auto platformScale = globalNow > 0 ? display->scale / globalNow : display->scale;
    if (platformScale > 0)
        desktop.setGlobalScaleFactor ((float) (scale / platformScale));

    // GTK (the WebKit view): integer device scale, no extra text scaling on top.
    ::setenv ("GDK_SCALE", juce::String (scale).toRawUTF8(), 1);
    ::unsetenv ("GDK_DPI_SCALE");

    std::cerr << "[Gomidas] UI scale " << scale << " (display " << juce::roundToInt (display->dpi)
              << " dpi" << (std::getenv ("GOMIDAS_SCALE") != nullptr ? ", GOMIDAS_SCALE override" : "")
              << ")" << std::endl;
   #endif
}
}
