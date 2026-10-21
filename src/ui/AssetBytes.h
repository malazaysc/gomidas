#pragma once
// Bytes served for an embedded web asset (GOM-90). Header-only and JUCE-free so
// tests/asset_bytes_test.cpp can pin it without the GUI.
//
// WebKitGTK ignores the Content-Type JUCE sets on resource-provider responses, so assets reach
// the page untyped and text decodes as windows-1252. A UTF-8 BOM outranks that and is stripped
// before parsing, so on WebKitGTK every UTF-8 text asset is served with one.
#include <cstddef>
#include <cstring>
#include <string_view>
#include <vector>

namespace gomidas
{
// UTF-8 text formats the page may decode: text/*, JSON, JavaScript, and any XML (incl. SVG).
inline bool isUtf8TextMime (std::string_view mime)
{
    auto endsWith = [&] (std::string_view s) { return mime.size() >= s.size() && mime.substr (mime.size() - s.size()) == s; };
    return mime.rfind ("text/", 0) == 0
        || mime == "application/json" || mime == "application/javascript"
        || mime == "application/xml" || endsWith ("+xml");
}

// One allocation, one copy: the BOM (when wanted and not already present) followed by the data.
inline std::vector<std::byte> assetBytes (const char* data, std::size_t size, std::string_view mime, bool addBom)
{
    static constexpr unsigned char bom[] = { 0xEF, 0xBB, 0xBF };
    const bool prefix = addBom && isUtf8TextMime (mime)
                     && ! (size >= sizeof (bom) && std::memcmp (data, bom, sizeof (bom)) == 0);
    const std::size_t offset = prefix ? sizeof (bom) : 0;

    std::vector<std::byte> out (size + offset);
    if (prefix)
        std::memcpy (out.data(), bom, sizeof (bom));
    if (size > 0)
        std::memcpy (out.data() + offset, data, size);
    return out;
}
} // namespace gomidas
