export const TORZNAB_TWO_ITEM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>Voyager</title>
    <item>
      <title>Blade.Runner.1982.Final.Cut.2160p.UHD.BluRay.x265-GRP</title>
      <guid>https://indexer.example/details/aaa</guid>
      <jackettindexer>ExampleTracker</jackettindexer>
      <link>https://indexer.example/download/aaa</link>
      <pubDate>Sat, 01 Feb 2025 12:00:00 +0000</pubDate>
      <size>26843545600</size>
      <category>2040</category>
      <enclosure url="https://indexer.example/download/aaa" length="26843545600" type="application/x-bittorrent" />
      <torznab:attr name="category" value="2040" />
      <torznab:attr name="seeders" value="34" />
      <torznab:attr name="peers" value="40" />
      <torznab:attr name="infohash" value="0123456789ABCDEF0123456789ABCDEF01234567" />
      <torznab:attr name="magneturl" value="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&amp;dn=blade" />
    </item>
    <item>
      <title>Blade.Runner.1982.Final.Cut.1080p.BluRay.x264-GRP</title>
      <guid>https://indexer.example/details/bbb</guid>
      <link>magnet:?xt=urn:btih:89abcdef012345670123456789abcdef01234567</link>
      <pubDate>Sun, 02 Feb 2025 08:30:00 +0000</pubDate>
      <size>1468006400</size>
      <torznab:attr name="category" value="2030" />
      <torznab:attr name="seeders" value="120" />
      <torznab:attr name="peers" value="140" />
    </item>
  </channel>
</rss>`;

export const TORZNAB_EMPTY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>Voyager</title>
  </channel>
</rss>`;

export const TORZNAB_ERROR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<error code="910" description="Invalid API key"/>`;
