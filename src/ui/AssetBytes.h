#pragma once
// Bytes served for an embedded web asset (GOM-90). Header-only and JUCE-free so
// tests/asset_bytes_test.cpp can pin it without the GUI.
//
// WebKitGTK ignores the Content-Type JUCE sets on resource-provider responses, so assets reach
// the page untyped and text decodes as windows-1252. A UTF-8 BOM outranks that and is stripped
// before parsing, so on WebKitGTK every UTF-8 text asset is served with one. The underlying
// missing content type is GOM-94.
//
// Embedded text assets must be UTF-8: index.html, the tsc output under dist/, and the vendored
// alphaTab.min.js and juce_native_interop.js all are. Re-vendoring one in another encoding
// would decode wrongly on Linux only.
#include <cctype>
#include <cstddef>
#include <cstring>
#include <string>
#include <string_view>
#include <vector>

namespace gomidas
{
// Platforms where JUCE's WebBrowserComponent is WebKitGTK (JUCE_LINUX / JUCE_BSD) and therefore
// needs the BOM. Keyed off the compiler's own macros, not JUCE's, so the answer cannot depend on
// whether a JUCE header was included first.
#if defined (__linux__) || defined (__FreeBSD__) || defined (__NetBSD__) || defined (__OpenBSD__)
 constexpr bool kWebViewNeedsUtf8Bom = true;
#else
 constexpr bool kWebViewNeedsUtf8Bom = false;
#endif

namespace detail
{
    inline std::string lowerTrimmed (std::string_view s)
    {
        while (! s.empty() && std::isspace ((unsigned char) s.front())) s.remove_prefix (1);
        while (! s.empty() && std::isspace ((unsigned char) s.back()))  s.remove_suffix (1);
        std::string out (s);
        for (auto& c : out)
            c = (char) std::tolower ((unsigned char) c);
        return out;
    }
}

// UTF-8 text formats the page decodes: text/*, JSON (+json), JavaScript, XML (+xml, incl. SVG).
// Case- and whitespace-insensitive. A charset parameter other than utf-8 means "not UTF-8".
inline bool isUtf8TextMime (std::string_view mime)
{
    const auto semi = mime.find (';');
    const auto type = detail::lowerTrimmed (mime.substr (0, semi));

    if (semi != std::string_view::npos)
    {
        const auto params = detail::lowerTrimmed (mime.substr (semi + 1));
        const auto at = params.find ("charset=");
        if (at != std::string::npos)
        {
            auto charset = std::string_view (params).substr (at + 8);
            charset = charset.substr (0, charset.find (';'));
            if (! charset.empty() && (charset.front() == '"' || charset.front() == '\''))
                charset = charset.substr (1, charset.size() >= 2 ? charset.size() - 2 : 0);
            if (charset != "utf-8" && charset != "utf8")
                return false;
        }
    }

    auto endsWith = [&] (std::string_view s) { return type.size() >= s.size() && type.compare (type.size() - s.size(), s.size(), s) == 0; };
    return type.rfind ("text/", 0) == 0
        || type == "application/json" || endsWith ("+json")
        || type == "application/javascript" || type == "application/x-javascript"
        || type == "application/xml" || endsWith ("+xml");
}

// One allocation, one copy: the UTF-8 BOM (when wanted) followed by the data. Nothing is added
// to an asset that already starts with a UTF-8 or UTF-16 byte-order mark. (UTF-32 is not a web
// encoding at all, so there is nothing to protect there.)
inline std::vector<std::byte> assetBytes (const char* data, std::size_t size, std::string_view mime, bool addBom)
{
    static constexpr unsigned char utf8Bom[]    = { 0xEF, 0xBB, 0xBF };
    static constexpr unsigned char utf16LeBom[] = { 0xFF, 0xFE };
    static constexpr unsigned char utf16BeBom[] = { 0xFE, 0xFF };
    auto startsWith = [&] (const unsigned char* mark, std::size_t n) { return size >= n && std::memcmp (data, mark, n) == 0; };

    const bool hasMark = startsWith (utf8Bom, sizeof (utf8Bom))
                      || startsWith (utf16LeBom, sizeof (utf16LeBom))
                      || startsWith (utf16BeBom, sizeof (utf16BeBom));
    const bool prefix = addBom && ! hasMark && isUtf8TextMime (mime);
    const std::size_t offset = prefix ? sizeof (utf8Bom) : 0;

    std::vector<std::byte> out (size + offset);
    if (prefix)
        std::memcpy (out.data(), utf8Bom, sizeof (utf8Bom));
    if (size > 0)
        std::memcpy (out.data() + offset, data, size);
    return out;
}
} // namespace gomidas
