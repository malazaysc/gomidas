#pragma once
// Bytes served for an embedded web asset (GOM-90). Header-only and JUCE-free so
// tests/asset_bytes_test.cpp can pin it without the GUI.
//
// WebKitGTK ignores the Content-Type JUCE sets on resource-provider responses, so assets reach
// the page untyped and text decodes as windows-1252. A UTF-8 BOM outranks that and is stripped
// before parsing, so on WebKitGTK every UTF-8 text asset is served with one.
//
// Embedded text assets must be saved as UTF-8 (they all are: index.html and the tsc output).
#include <cctype>
#include <cstddef>
#include <cstring>
#include <initializer_list>
#include <string>
#include <string_view>
#include <vector>

namespace gomidas
{
// Text formats the page decodes: text/*, JSON (+json), JavaScript, XML (+xml, incl. SVG).
// Case-insensitive, and parameters ("; charset=…") are ignored.
inline bool isUtf8TextMime (std::string_view mime)
{
    std::string m (mime.substr (0, mime.find (';')));
    while (! m.empty() && std::isspace ((unsigned char) m.back()))
        m.pop_back();
    for (auto& c : m)
        c = (char) std::tolower ((unsigned char) c);

    auto endsWith = [&] (std::string_view s) { return m.size() >= s.size() && m.compare (m.size() - s.size(), s.size(), s) == 0; };
    return m.rfind ("text/", 0) == 0
        || m == "application/json" || endsWith ("+json")
        || m == "application/javascript" || m == "application/x-javascript"
        || m == "application/xml" || endsWith ("+xml");
}

// One allocation, one copy: the BOM (when wanted) followed by the data. Nothing is added to an
// asset that already starts with a UTF-8 or UTF-16 byte-order mark.
inline std::vector<std::byte> assetBytes (const char* data, std::size_t size, std::string_view mime, bool addBom)
{
    static constexpr unsigned char bom[] = { 0xEF, 0xBB, 0xBF };
    auto startsWith = [&] (std::initializer_list<unsigned char> mark)
    {
        return size >= mark.size() && std::memcmp (data, mark.begin(), mark.size()) == 0;
    };
    const bool hasMark = startsWith ({ 0xEF, 0xBB, 0xBF }) || startsWith ({ 0xFF, 0xFE }) || startsWith ({ 0xFE, 0xFF });
    const bool prefix = addBom && isUtf8TextMime (mime) && ! hasMark;
    const std::size_t offset = prefix ? sizeof (bom) : 0;

    std::vector<std::byte> out (size + offset);
    if (prefix)
        std::memcpy (out.data(), bom, sizeof (bom));
    if (size > 0)
        std::memcpy (out.data() + offset, data, size);
    return out;
}
} // namespace gomidas
