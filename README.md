# ua-stremio-addon
## Project Overview
Ukrainian torrents addon for Stremio, leveraging Toloka and Mazepa sources with Ukrainian audio support.

## Current State
- Built with Stremio Addon SDK v1.6.10
- Uses axios (1.6.0) for API calls
- Supports movie/series content discovery
- Implements session caching
- Handles torrent metadata parsing via parse-torrent (11.0.21)

## Key Files
- `src/addon.js`: Core addon logic
- `src/config.js`: Configuration management
- `src/toloka.js`/`src/mazepa.js`: Source integrations
- `src/torrentCache.js`: Torrent metadata caching

## Issues Identified
1. Missing README documentation
2. Limited error resilience in network requests
3. Potential parsing edge cases for magnet links
4. No input validation for credentials
5. Missing test suite
6. Outdated dependency references (no explicit version ranges)
7.CLI configurability could be improved

## Proposed Improvements
### 1. Documentation
- Create comprehensive README.md
-- Installation instructions
-- Configuration guide
-- Usage examples
-- Known limitations
-- Legal disclaimer

### 2. Security Enhancements
- Add input validation for credentials
- Implement cookie sanitization
- Add HTTP request timeouts
- Consider Content Security Policy headers

### 3. Code Quality
- Extract search logic into separate service classes
- Improve error handling consistency
- Add type checking with TypeScript (if possible)
- Better comment documentation

### 4. Performance Optimizations
- Replace fixed sleep delays with priority-based scheduling
- Implement parallel processing for parallel requests
- Optimize torrent parsing for large files

### 5. Feature Enhancements
- Add magnet link support (currently partial)
- Implement streaming quality selection
- Add progress indicators for searches
- Support multi-region torrents

### 6. Testing
- Add unit tests for core logic
-- Test login flow
-- Test torrent parsing edge cases
-- Test error handling scenarios
- Add integration tests for Stremio

### 7. Dependency Management
- Pin exact versions where necessary
- Add automated dependency updates
- Review security advisories for dependencies

### 8. User Experience
- Add clear source selection UI
-- Toloka/Mazepa toggle
-- Credential management interface
- Implement proper error messages in Stremio
-- Status dashboard for background operations

## Next Steps
1. Implement README documentation
2. Add basic unit tests
3. Improve error handling
4. Implement security reviews
5. Add configuration UI
6. Submit PRs for each major improvement

## Dependencies
```json
// From package.json
  "dependencies": {
    "axios": "^1.6.0",
    "cheerio": "^1.0.0",
    "parse-torrent": "^11.0.21",
    "stremio-addon-sdk": "^1.6.10",
    "webtorrent": "^1.9.7"
  }```