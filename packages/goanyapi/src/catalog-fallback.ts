/**
 * The bundled copy of GoAnyAPI's public catalog
 * (https://api.goanyapi.com/api/v1/mcp/catalog, schemaVersion 1), used
 * until a live read succeeds: when magpie's plugin host loads the plugin
 * (the named tools come from it, or from the copy the last live read left
 * on disk), and while api.goanyapi.com can't be reached.
 *
 * Generated from the live catalog on 2026-10-29 (35 entries). Regenerate it
 * from that URL when GoAnyAPI adds or renames an API, so an agent sees the
 * same tool names whether or not the live read worked.
 */

export type JsonSchema = {
  type: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: Array<string | number | boolean>;
  items?: JsonSchema;
  default?: string | number | boolean;
  additionalProperties?: boolean;
  // the live catalog also carries pattern, minLength, examples, oneOf, …
  [keyword: string]: unknown;
};

export interface PublicApiDefinition {
  readonly id: string;
  readonly method: 'GET' | 'POST';
  readonly path: `/api/v1/${string}`;
  readonly inputSchema: JsonSchema;
  readonly mcpName: `goanyapi_${string}`;
  readonly description: string;
  readonly readOnly: true;
  readonly docsPath?: string;
}

export const apiCatalog: readonly PublicApiDefinition[] = [
  {
    "id": "capcut-most-used-times",
    "method": "GET",
    "path": "/api/v1/capcut-most-used/times",
    "mcpName": "goanyapi_capcut_most_used_times",
    "description": "List available successful CapCut Most Used snapshot hours for a required YYYYMMDD day in Asia/Shanghai (UTC+8). Returns hours as integers 0–23 in data.times. Free; authentication required. Historical snapshots are retained for 30 days; unavailable days return an empty array. This endpoint is free and does not consume credits.",
    "readOnly": true,
    "docsPath": "/docs/tiktok-capcut-trending-templates-api",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "day": {
          "type": "string",
          "pattern": "^[0-9]{8}$",
          "minLength": 8,
          "maxLength": 8,
          "description": "Required valid calendar date YYYYMMDD in Asia/Shanghai (UTC+8). Snapshots retained for 30 days; unavailable dates return no results.",
          "examples": [
            "20261027"
          ]
        }
      },
      "required": [
        "day"
      ]
    }
  },
  {
    "id": "capcut-most-used-history",
    "method": "GET",
    "path": "/api/v1/capcut-most-used/history",
    "mcpName": "goanyapi_capcut_most_used_history",
    "description": "Read a CapCut Most Used snapshot for required day (YYYYMMDD) and time (integer hour 0–23, Asia/Shanghai). First call goanyapi_capcut_most_used_times for available hours. page defaults to 0, range 0–19. Preserve day/time when following nextPage; stop when nextPage is null. Returns template IDs as strings, titles, covers, preview videos, usage estimates and historical positions. Duplicates and order are preserved; page size varies. Snapshots retained for 30 days. Non-empty successful pages use the configured rate; empty lists and failures are not charged. With the current configuration, each successful request costs 2 credits.",
    "readOnly": true,
    "docsPath": "/docs/tiktok-capcut-trending-templates-api",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "day": {
          "type": "string",
          "pattern": "^[0-9]{8}$",
          "minLength": 8,
          "maxLength": 8,
          "description": "Required valid calendar date YYYYMMDD in Asia/Shanghai (UTC+8). Snapshots retained for 30 days; unavailable dates return no results.",
          "examples": [
            "20261027"
          ]
        },
        "time": {
          "type": "integer",
          "minimum": 0,
          "maximum": 23,
          "description": "Required hour in Asia/Shanghai, chosen from the times response for the same day.",
          "examples": [
            10
          ]
        },
        "page": {
          "type": "integer",
          "minimum": 0,
          "maximum": 19,
          "default": 0,
          "description": "Zero-based page. Use nextPage from the preceding response; stop when null. Page size varies; duplicates are preserved.",
          "examples": [
            0,
            1
          ]
        }
      },
      "required": [
        "day",
        "time"
      ]
    }
  },
  {
    "id": "capcut-most-used-realtime",
    "method": "GET",
    "path": "/api/v1/capcut-most-used/realtime",
    "mcpName": "goanyapi_capcut_most_used_realtime",
    "description": "Read one current CapCut Most Used template page. page defaults to 0, range 0–19. Follow returned nextPage until null; results may change between requests. Returns string template IDs, titles, template links, covers, preview videos and usage estimates. Duplicates and order are preserved; count includes duplicate cards and page size varies. Non-empty successful pages use the configured rate; empty lists and failures are not charged. With the current configuration, each successful request costs 2 credits.",
    "readOnly": true,
    "docsPath": "/docs/tiktok-capcut-trending-templates-api",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "page": {
          "type": "integer",
          "minimum": 0,
          "maximum": 19,
          "default": 0,
          "description": "Zero-based page. Use nextPage from the preceding response; stop when null. Page size varies; duplicates are preserved.",
          "examples": [
            0,
            1
          ]
        }
      },
      "required": []
    }
  },
  {
    "id": "taaft-tools-api",
    "method": "GET",
    "path": "/api/v1/taaft-tools",
    "mcpName": "goanyapi_taaft_tools_api",
    "description": "Browse the TAAFT AI tools catalog by zero-based page (default 0). Returns items with name, nullable version, description, category, domain, pricingText, releasedAt and links. Returns total, page, pageSize and totalPages; use nextPage while hasMore is true. nextPage is null on the last page or an empty catalog. Optional year selects releases for an entire year; optional month requires year and selects that month. Future years and months are rejected in Asia/Shanghai. Returns nullable numeric views, saves and averageRating. No pageSize input. Non-empty successful pages use the configured credit rate; empty lists and failures are not charged. With the current configuration, each successful request costs 2 credits.",
    "readOnly": true,
    "docsPath": "/docs/taaft-tools-api",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "page": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991,
          "default": 0,
          "description": "Zero-based page. Omit for page 0. Use nextPage while hasMore is true and keep the same year/month filters; an empty items array is valid. No pageSize input.",
          "examples": [
            0,
            1
          ]
        },
        "year": {
          "type": "integer",
          "minimum": 2015,
          "maximum": 2026,
          "description": "Optional release year in Asia/Shanghai. Omit year and month for all releases; year alone selects the entire year.",
          "examples": [
            2025,
            2026
          ]
        },
        "month": {
          "type": "integer",
          "minimum": 1,
          "maximum": 12,
          "description": "Optional release month; requires year. For year 2026, maximum month is 10. Omit for the entire selected year.",
          "examples": [
            1
          ]
        }
      },
      "required": [],
      "oneOf": [
        {
          "type": "object",
          "not": {
            "type": "object",
            "anyOf": [
              {
                "type": "object",
                "required": [
                  "year"
                ]
              },
              {
                "type": "object",
                "required": [
                  "month"
                ]
              }
            ]
          }
        },
        {
          "type": "object",
          "required": [
            "year"
          ],
          "not": {
            "type": "object",
            "required": [
              "month"
            ]
          }
        },
        {
          "type": "object",
          "required": [
            "year",
            "month"
          ],
          "properties": {
            "year": {
              "type": "integer",
              "maximum": 2025
            },
            "month": {
              "type": "integer",
              "maximum": 12
            }
          }
        },
        {
          "type": "object",
          "required": [
            "year",
            "month"
          ],
          "properties": {
            "year": {
              "type": "integer",
              "enum": [
                2026
              ]
            },
            "month": {
              "type": "integer",
              "maximum": 10
            }
          }
        }
      ]
    }
  },
  {
    "id": "taaft-just-released-api",
    "method": "GET",
    "path": "/api/v1/taaft-just-released-api",
    "mcpName": "goanyapi_taaft_just_released_api",
    "description": "List tools from the Just Released section of There's An AI For That (TAAFT, theresanaiforthat.com), an AI tools directory. This endpoint covers TAAFT listings only, not other AI directories or all AI tool launches. Optional day is YYYYMMDD in Asia/Shanghai (UTC+8), defaults to today, and must be within the latest 30 calendar days including today. Returns day and the available items for that date, including name, description, category, domain, pricingText, releasedAt and links. No pagination. Non-empty successful results use the configured credit rate; empty lists and failures are not charged. With the current configuration, each successful request costs 2 credits.",
    "readOnly": true,
    "docsPath": "/docs/taaft-just-released-api",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "day": {
          "type": "string",
          "pattern": "^[0-9]{8}$",
          "enum": [
            "20261029",
            "20261028",
            "20261027",
            "20261026",
            "20261025",
            "20261024",
            "20261023",
            "20261022",
            "20261021",
            "20261020",
            "20261019",
            "20261018",
            "20261017",
            "20261016",
            "20261015",
            "20261014",
            "20261013",
            "20261012",
            "20261011",
            "20261010",
            "20261009",
            "20261008",
            "20261007",
            "20261006",
            "20261005",
            "20261004",
            "20261003",
            "20261002",
            "20261001",
            "20260930"
          ],
          "default": "20261029",
          "description": "Optional YYYYMMDD date in Asia/Shanghai (UTC+8). Omit for today. Accepts the latest 30 calendar days including today (20260930–20261029); future dates are rejected. Returns all items for that date; no pagination.",
          "examples": [
            "20261029",
            "20260930"
          ]
        }
      },
      "required": []
    }
  },
  {
    "id": "tiktok-creator",
    "method": "GET",
    "path": "/api/v1/tiktok-creator",
    "mcpName": "goanyapi_tiktok_creator",
    "description": "List CapCut creator templates with TikTok Creator API. Provide exactly one of profileId or url. type=video (default) lists video templates; type=image lists image templates. cursor defaults to 0; use new_cursor for the next page while has_more is true. Each page contains up to 20 templates, fixed. Each non-empty page uses the configured credit rate; empty lists and failures are not charged. With the current configuration, each successful request costs 3 credits.",
    "readOnly": true,
    "docsPath": "/docs/tiktok-creator-api",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "profileId": {
          "type": "string",
          "pattern": "^[A-Za-z0-9_-]{1,202}$",
          "description": "CapCut creator profile ID containing letters, digits, underscores or hyphens; a p- prefix is not required. Provide exactly one of profileId or url.",
          "examples": [
            "p-kYX4pYJcVgN831-fvSPFbjrcI__F_99soyLmN877o"
          ]
        },
        "url": {
          "type": "string",
          "pattern": "^https://(www\\.)?capcut\\.com/profile/[A-Za-z0-9_-]{1,202}/?(\\?[^#]*)?(#.*)?$",
          "maxLength": 2048,
          "description": "HTTPS CapCut /profile/{profileId} URL, parsed locally. Mutually exclusive with profileId.",
          "examples": [
            "https://www.capcut.com/profile/p-kYX4pYJcVgN831-fvSPFbjrcI__F_99soyLmN877o"
          ]
        },
        "type": {
          "type": "string",
          "enum": [
            "video",
            "image"
          ],
          "default": "video",
          "description": "video lists video templates; image lists image templates."
        },
        "cursor": {
          "type": "string",
          "pattern": "^[0-9]{1,20}$",
          "default": "0",
          "description": "Start with 0. For the next page, pass new_cursor from the preceding response unchanged. Stop when has_more is false.",
          "examples": [
            "0",
            "1733081486000"
          ]
        }
      },
      "oneOf": [
        {
          "type": "object",
          "required": [
            "profileId"
          ],
          "not": {
            "type": "object",
            "required": [
              "url"
            ]
          }
        },
        {
          "type": "object",
          "required": [
            "url"
          ],
          "not": {
            "type": "object",
            "required": [
              "profileId"
            ]
          }
        }
      ]
    }
  },
  {
    "id": "html-to-markdown-api",
    "method": "GET",
    "path": "/api/v1/html-to-markdown-api",
    "mcpName": "goanyapi_html_to_markdown_api",
    "description": "Convert a public web page to Markdown. Provide url; optionally choose image and link retention or a CSS selector for the target content. A successful request for https://google.com is free; other successful requests use the configured credit price.",
    "readOnly": true,
    "docsPath": "/docs/html-to-markdown-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "pattern": "^[Hh][Tt][Tt][Pp][Ss]?://",
          "maxLength": 2048,
          "description": "Public HTTP or HTTPS page URL. https://google.com is a free live demo; local and private addresses are not accepted.",
          "examples": [
            "https://google.com"
          ]
        },
        "retainImages": {
          "type": "string",
          "enum": [
            "all",
            "alt",
            "none"
          ],
          "default": "all",
          "description": "all keeps images, alt keeps alt text only, none removes images."
        },
        "retainLinks": {
          "type": "string",
          "enum": [
            "all",
            "text",
            "none"
          ],
          "default": "all",
          "description": "all keeps links, text keeps link text only, none removes links."
        },
        "targetSelector": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Optional CSS selector for the content to extract, for example article.",
          "examples": [
            "article"
          ]
        }
      },
      "required": [
        "url"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "trustmrr-api",
    "method": "GET",
    "path": "/api/v1/trustmrr-api",
    "mcpName": "goanyapi_trustmrr_api",
    "description": "List TrustMRR projects and revenue with zero-based pagination. page defaults to 0; pageSize is fixed at 10. Returns items, total, page, pageSize and totalPages. Replaces the former domain lookup; use page instead of domain.",
    "readOnly": true,
    "docsPath": "/docs/trustmrr-api",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "page": {
          "type": "integer",
          "minimum": 0,
          "maximum": 9007199254740991,
          "default": 0,
          "description": "Zero-based page index. Example: 0 for the first page.",
          "examples": [
            0,
            1
          ]
        },
        "pageSize": {
          "type": "integer",
          "enum": [
            10
          ],
          "default": 10,
          "description": "Fixed at 10 items per page."
        }
      },
      "required": []
    }
  },
  {
    "id": "chrome-web-store-reviews",
    "method": "GET",
    "path": "/api/v1/chrome-web-store-reviews",
    "mcpName": "goanyapi_chrome_web_store_reviews",
    "description": "Fetch Chrome Web Store reviews with cursor pagination.",
    "readOnly": true,
    "docsPath": "/docs/chrome-web-store-reviews-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "extensionId": {
          "type": "string",
          "minLength": 32,
          "maxLength": 2048,
          "description": "A 32-character Chrome extension ID or a Chrome Web Store URL.",
          "examples": [
            "hldjnlbobkdkghfidgoecgmklcemanhm",
            "https://chromewebstore.google.com/detail/hldjnlbobkdkghfidgoecgmklcemanhm"
          ]
        },
        "cursor": {
          "type": "string",
          "maxLength": 4096,
          "description": "Opaque cursor returned by the previous response; omit it for the first page."
        }
      },
      "required": [
        "extensionId"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "traffic",
    "method": "GET",
    "path": "/api/v1/traffic",
    "mcpName": "goanyapi_traffic",
    "description": "Query website traffic, ranking, and traffic sources for a domain.",
    "readOnly": true,
    "docsPath": "/docs/traffic-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "domain": {
          "type": "string",
          "description": "Domain name, for example example.com"
        },
        "month": {
          "type": "integer",
          "enum": [
            3,
            6,
            12
          ],
          "default": 3,
          "description": "Traffic history range in months"
        }
      },
      "required": [
        "domain"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "dr",
    "method": "GET",
    "path": "/api/v1/dr",
    "mcpName": "goanyapi_domain_rating",
    "description": "Query the domain rating for a domain.",
    "readOnly": true,
    "docsPath": "/docs/dr-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "domain": {
          "type": "string",
          "description": "Domain name, for example example.com"
        }
      },
      "required": [
        "domain"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "dr-history",
    "method": "GET",
    "path": "/api/v1/dr-history",
    "mcpName": "goanyapi_domain_rating_history",
    "description": "Query monthly Domain Rating history. Ratings may contain decimals. Set includeDr=false to preview the available months and exact required credits without a deduction, or includeDr=true to return ratings and charge the current Domain Rating credit cost for each returned month. An empty history returns an empty list and costs 0 credits. Both modes require enough credits for the full result; insufficient balance returns HTTP 402 without history data.",
    "readOnly": true,
    "docsPath": "/docs/domain-rating-history-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "domain": {
          "type": "string",
          "description": "Domain name, for example example.com"
        },
        "includeDr": {
          "type": "boolean",
          "default": false,
          "description": "Whether to return Domain Rating values. Defaults to false. false returns only months plus the exact required credits and deducts 0 credits; true returns month and dr values and deducts the current Domain Rating credit cost for each returned month. Both modes return HTTP 402 without history data when the balance is insufficient."
        }
      },
      "required": [
        "domain"
      ],
      "additionalProperties": false,
      "examples": [
        {
          "domain": "kviku.com",
          "includeDr": false
        },
        {
          "domain": "kviku.com",
          "includeDr": true
        }
      ]
    }
  },
  {
    "id": "backlink",
    "method": "GET",
    "path": "/api/v1/backlink",
    "mcpName": "goanyapi_backlinks",
    "description": "Query backlink data for a domain.",
    "readOnly": true,
    "docsPath": "/docs/backlink-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "domain": {
          "type": "string",
          "description": "Domain name, for example example.com"
        }
      },
      "required": [
        "domain"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "keyword-difficulty",
    "method": "GET",
    "path": "/api/v1/keyword-difficulty",
    "mcpName": "goanyapi_keyword_difficulty",
    "description": "Query keyword difficulty and related search metrics.",
    "readOnly": true,
    "docsPath": "/docs/keyword-difficulty-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "keyword": {
          "type": "string",
          "description": "Search keyword"
        },
        "country": {
          "type": "string",
          "description": "Two-letter country code, for example us"
        }
      },
      "required": [
        "keyword"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "keyword-generator",
    "method": "GET",
    "path": "/api/v1/keyword-generator",
    "mcpName": "goanyapi_keyword_generator",
    "description": "Generate related keyword ideas for a keyword.",
    "readOnly": true,
    "docsPath": "/docs/keyword-generator-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "keyword": {
          "type": "string",
          "description": "Search keyword"
        },
        "country": {
          "type": "string",
          "description": "Two-letter country code, for example us"
        }
      },
      "required": [
        "keyword"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "keyword-suggestions",
    "method": "GET",
    "path": "/api/v1/keyword-suggestions",
    "mcpName": "goanyapi_keyword_suggestions",
    "description": "Get paginated keyword suggestions before querying an exact keyword with the Keyword Search Volume API.",
    "readOnly": true,
    "docsPath": "/docs/keyword-suggestions-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "keyword": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Keyword fragment used to find suggestions, from 1 to 200 characters."
        },
        "page": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100000,
          "default": 0,
          "description": "Zero-based results page. Defaults to 0."
        }
      },
      "required": [
        "keyword"
      ],
      "additionalProperties": false,
      "examples": [
        {
          "keyword": "ai",
          "page": 0
        }
      ]
    }
  },
  {
    "id": "keyword-search-volume",
    "method": "GET",
    "path": "/api/v1/keyword-search-volume",
    "mcpName": "goanyapi_keyword_search_volume",
    "description": "First call Keyword Suggestions API, then pass an exact value from its data.keywords results.",
    "readOnly": true,
    "docsPath": "/docs/keyword-search-volume-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "keyword": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Exact keyword to query, from 1 to 200 characters."
        }
      },
      "required": [
        "keyword"
      ],
      "additionalProperties": false,
      "examples": [
        {
          "keyword": "ai image"
        }
      ]
    }
  },
  {
    "id": "google-autocomplete",
    "method": "GET",
    "path": "/api/v1/google-autocomplete",
    "mcpName": "goanyapi_google_autocomplete",
    "description": "Get Google autocomplete suggestions for a query.",
    "readOnly": true,
    "docsPath": "/docs/google-autocomplete-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Search query. Google queries are trimmed before sending."
        },
        "domain": {
          "type": "string",
          "enum": [
            "www.google.com",
            "www.google.com.hk"
          ],
          "default": "www.google.com",
          "description": "Optional Google country domain."
        },
        "hl": {
          "type": "string",
          "default": "en",
          "pattern": "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$",
          "description": "Optional language code, for example en or zh-CN."
        }
      },
      "required": [
        "q"
      ],
      "additionalProperties": false,
      "examples": [
        {
          "q": "ai image",
          "domain": "www.google.com",
          "hl": "en"
        }
      ]
    }
  },
  {
    "id": "bing-autocomplete",
    "method": "GET",
    "path": "/api/v1/bing-autocomplete",
    "mcpName": "goanyapi_bing_autocomplete",
    "description": "Get Bing autocomplete suggestions for a query.",
    "readOnly": true,
    "docsPath": "/docs/bing-autocomplete-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Search query. Leading and trailing spaces are preserved."
        },
        "mkt": {
          "type": "string",
          "default": "en-US",
          "pattern": "^[a-z]{2}-[A-Z]{2}$",
          "description": "Optional search market, for example en-US."
        }
      },
      "required": [
        "q"
      ],
      "additionalProperties": false,
      "examples": [
        {
          "q": "ai image",
          "mkt": "en-US"
        }
      ]
    }
  },
  {
    "id": "duckduckgo-autocomplete",
    "method": "GET",
    "path": "/api/v1/duckduckgo-autocomplete",
    "mcpName": "goanyapi_duckduckgo_autocomplete",
    "description": "Get DuckDuckGo autocomplete suggestions for a query with an optional regional setting.",
    "readOnly": true,
    "docsPath": "/docs/duckduckgo-autocomplete-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Search query. Leading and trailing spaces are preserved."
        },
        "kl": {
          "type": "string",
          "default": "wt-wt",
          "pattern": "^[A-Za-z]{2}-[A-Za-z]{2,3}$",
          "description": "Optional DuckDuckGo region code, for example wt-wt. Region reference: https://duckduckgo.com/duckduckgo-help-pages/settings/params"
        }
      },
      "required": [
        "q"
      ],
      "additionalProperties": false,
      "examples": [
        {
          "q": "ai image",
          "kl": "wt-wt"
        }
      ]
    }
  },
  {
    "id": "naver-autocomplete",
    "method": "GET",
    "path": "/api/v1/naver-autocomplete",
    "mcpName": "goanyapi_naver_autocomplete",
    "description": "Get Naver autocomplete suggestions for a query.",
    "readOnly": true,
    "docsPath": "/docs/naver-autocomplete-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Search query. Leading and trailing spaces are preserved."
        }
      },
      "required": [
        "q"
      ],
      "additionalProperties": false,
      "examples": [
        {
          "q": "ai image"
        }
      ]
    }
  },
  {
    "id": "coccoc-autocomplete",
    "method": "GET",
    "path": "/api/v1/coccoc-autocomplete",
    "mcpName": "goanyapi_coccoc_autocomplete",
    "description": "Get Coc Coc autocomplete suggestions for a query.",
    "readOnly": true,
    "docsPath": "/docs/coccoc-autocomplete-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Search query. Leading and trailing spaces are preserved."
        }
      },
      "required": [
        "q"
      ],
      "additionalProperties": false,
      "examples": [
        {
          "q": "ai image"
        }
      ]
    }
  },
  {
    "id": "yandex-autocomplete",
    "method": "GET",
    "path": "/api/v1/yandex-autocomplete",
    "mcpName": "goanyapi_yandex_autocomplete",
    "description": "Get Yandex autocomplete suggestions for a query with an optional interface language.",
    "readOnly": true,
    "docsPath": "/docs/yandex-autocomplete-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Search query. Leading and trailing spaces are preserved."
        },
        "uil": {
          "type": "string",
          "default": "en",
          "pattern": "^[A-Za-z]{2,3}$",
          "description": "Optional two- or three-letter interface language code, for example en or ru."
        }
      },
      "required": [
        "q"
      ],
      "additionalProperties": false,
      "examples": [
        {
          "q": "ai image",
          "uil": "en"
        }
      ]
    }
  },
  {
    "id": "youtube-autocomplete",
    "method": "GET",
    "path": "/api/v1/youtube-autocomplete",
    "mcpName": "goanyapi_youtube_autocomplete",
    "description": "Get localized YouTube search suggestions for a query.",
    "readOnly": true,
    "docsPath": "/docs/youtube-autocomplete-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Search query. Leading and trailing spaces are preserved."
        },
        "hl": {
          "type": "string",
          "default": "en",
          "pattern": "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$",
          "description": "Optional YouTube suggestion language, for example en or zh-CN."
        },
        "gl": {
          "type": "string",
          "default": "US",
          "pattern": "^[A-Za-z]{2}$",
          "description": "Optional two-letter country code, for example US or CN."
        }
      },
      "required": [
        "q"
      ],
      "additionalProperties": false,
      "examples": [
        {
          "q": "ai image",
          "hl": "en",
          "gl": "US"
        }
      ]
    }
  },
  {
    "id": "yahoo-autocomplete",
    "method": "GET",
    "path": "/api/v1/yahoo-autocomplete",
    "mcpName": "goanyapi_yahoo_autocomplete",
    "description": "Get Yahoo US search suggestions for a query.",
    "readOnly": true,
    "docsPath": "/docs/yahoo-autocomplete-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Search query. Leading and trailing spaces are preserved."
        }
      },
      "required": [
        "q"
      ],
      "additionalProperties": false,
      "examples": [
        {
          "q": "ai image"
        }
      ]
    }
  },
  {
    "id": "serp",
    "method": "GET",
    "path": "/api/v1/serp",
    "mcpName": "goanyapi_google_serp",
    "description": "Query structured Google search results.",
    "readOnly": true,
    "docsPath": "/docs/serp-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "description": "Search keyword"
        },
        "filter": {
          "type": "string",
          "description": "Similar-result filtering: 0 or 1"
        },
        "cr": {
          "type": "string",
          "description": "Result country restriction, e.g. countryUS"
        },
        "lr": {
          "type": "string",
          "description": "Result language restriction, e.g. lang_en"
        },
        "nfpr": {
          "type": "string",
          "description": "Automatic correction control: 0 or 1"
        },
        "gl": {
          "type": "string",
          "description": "Two-letter country code, for example us"
        },
        "hl": {
          "type": "string",
          "description": "Optional interface language, e.g. en or zh-cn"
        },
        "start": {
          "type": "integer",
          "description": "Result offset"
        },
        "device": {
          "type": "string",
          "description": "Optional desktop or mobile device"
        },
        "browser": {
          "type": "string",
          "description": "Optional browser name"
        },
        "safe": {
          "type": "string",
          "description": "Optional safe-search mode"
        },
        "tbs": {
          "type": "string",
          "description": "Optional advanced time filter, e.g. qdr:w"
        },
        "search_type": {
          "type": "string",
          "description": "Optional search vertical"
        }
      },
      "required": [
        "q"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "bing-serp",
    "method": "GET",
    "path": "/api/v1/bing-serp",
    "mcpName": "goanyapi_bing_serp",
    "description": "Query structured Bing search results with pagination and localization options.",
    "readOnly": true,
    "docsPath": "/docs/bing-serp-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "description": "Search keyword"
        },
        "cc": {
          "type": "string",
          "description": "Optional lowercase two-letter country code"
        },
        "setLang": {
          "type": "string",
          "description": "Optional language-country code such as en-US"
        },
        "first": {
          "type": "integer",
          "description": "Pagination start from the previous response"
        },
        "device": {
          "type": "string",
          "description": "Optional desktop, mobile, ios, ipad, android, or tablet device"
        },
        "brd_browser": {
          "type": "string",
          "description": "Optional chrome, safari, or firefox browser"
        }
      },
      "required": [
        "q"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "google-intitle",
    "method": "GET",
    "path": "/api/v1/google-intitle",
    "mcpName": "goanyapi_google_intitle",
    "description": "Find Google results whose titles contain the requested text.",
    "readOnly": true,
    "docsPath": "/docs/google-intitle-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "intitle": {
          "type": "string",
          "description": "Search keyword"
        },
        "qdr": {
          "type": "string",
          "description": "Optional date range filter"
        },
        "filter": {
          "type": "string",
          "description": "Similar-result filtering: 0 or 1"
        },
        "cr": {
          "type": "string",
          "description": "Result country restriction, e.g. countryUS"
        },
        "lr": {
          "type": "string",
          "description": "Result language restriction, e.g. lang_en"
        },
        "nfpr": {
          "type": "string",
          "description": "Automatic correction control: 0 or 1"
        },
        "start": {
          "type": "integer",
          "description": "Result offset from 0 to 990"
        },
        "tbs": {
          "type": "string",
          "description": "Advanced time filter, e.g. qdr:w; cannot combine with qdr"
        },
        "gl": {
          "type": "string",
          "description": "Two-letter country code, for example us"
        },
        "hl": {
          "type": "string",
          "description": "Optional interface language, e.g. en or zh-cn"
        },
        "device": {
          "type": "string",
          "description": "Optional desktop, mobile, or platform device"
        },
        "browser": {
          "type": "string",
          "description": "Optional chrome, safari, or firefox browser"
        },
        "safe": {
          "type": "string",
          "description": "Optional safe-search mode"
        }
      },
      "required": [
        "intitle"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "google-site-search",
    "method": "GET",
    "path": "/api/v1/google-site-search",
    "mcpName": "goanyapi_google_site_search",
    "description": "Search Google results limited to a specified website.",
    "readOnly": true,
    "docsPath": "/docs/google-site-search-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "site": {
          "type": "string",
          "description": "Domain name, for example example.com"
        },
        "qdr": {
          "type": "string",
          "description": "Optional date range filter"
        },
        "filter": {
          "type": "string",
          "description": "Similar-result filtering: 0 or 1"
        },
        "cr": {
          "type": "string",
          "description": "Result country restriction, e.g. countryUS"
        },
        "lr": {
          "type": "string",
          "description": "Result language restriction, e.g. lang_en"
        },
        "nfpr": {
          "type": "string",
          "description": "Automatic correction control: 0 or 1"
        },
        "start": {
          "type": "integer",
          "description": "Result offset from 0 to 990"
        },
        "tbs": {
          "type": "string",
          "description": "Advanced time filter, e.g. qdr:w; cannot combine with qdr"
        },
        "gl": {
          "type": "string",
          "description": "Two-letter country code, for example us"
        },
        "hl": {
          "type": "string",
          "description": "Optional interface language, e.g. en or zh-cn"
        },
        "device": {
          "type": "string",
          "description": "Optional desktop, mobile, or platform device"
        },
        "browser": {
          "type": "string",
          "description": "Optional chrome, safari, or firefox browser"
        },
        "safe": {
          "type": "string",
          "description": "Optional safe-search mode"
        }
      },
      "required": [
        "site"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "google-trends",
    "method": "GET",
    "path": "/api/v1/google-trends",
    "mcpName": "goanyapi_google_trends",
    "description": "Query Google Trends interest over time, related topics, or related queries. TIMESERIES accepts up to 5 keywords. Billing is calculated per keyword, including successful empty results.",
    "readOnly": true,
    "docsPath": "/docs/google-trends-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "q": {
          "type": "string",
          "minLength": 1,
          "maxLength": 504,
          "description": "Search query. TIMESERIES accepts up to 5 comma-separated queries; RELATED_TOPICS and RELATED_QUERIES accept exactly one query."
        },
        "date": {
          "type": "string",
          "enum": [
            "now 1-H",
            "now 4-H",
            "now 1-d",
            "now 7-d",
            "today 1-m",
            "today 3-m",
            "today 12-m",
            "today 5-y",
            "all"
          ],
          "default": "today 12-m",
          "description": "Google Trends time range."
        },
        "geo": {
          "type": "string",
          "pattern": "^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$",
          "maxLength": 64,
          "description": "Optional single region code shared by all queries."
        },
        "data_type": {
          "type": "string",
          "enum": [
            "TIMESERIES",
            "RELATED_TOPICS",
            "RELATED_QUERIES"
          ],
          "default": "TIMESERIES",
          "description": "TIMESERIES returns interest over time; RELATED_TOPICS returns related topics; RELATED_QUERIES returns related queries."
        }
      },
      "required": [
        "q"
      ],
      "additionalProperties": false,
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "data_type": {
              "type": "string",
              "enum": [
                "TIMESERIES"
              ]
            }
          },
          "required": [
            "q",
            "data_type"
          ]
        },
        {
          "type": "object",
          "properties": {
            "data_type": {
              "type": "string",
              "enum": [
                "RELATED_TOPICS",
                "RELATED_QUERIES"
              ]
            },
            "q": {
              "type": "string",
              "pattern": "^[^,]+$"
            }
          },
          "required": [
            "q",
            "data_type"
          ]
        },
        {
          "type": "object",
          "required": [
            "q"
          ],
          "not": {
            "type": "object",
            "required": [
              "data_type"
            ]
          }
        }
      ],
      "examples": [
        {
          "q": "ai video,chatgpt",
          "data_type": "TIMESERIES"
        },
        {
          "q": "ai video",
          "data_type": "RELATED_TOPICS"
        },
        {
          "q": "ai video",
          "data_type": "RELATED_QUERIES"
        }
      ]
    }
  },
  {
    "id": "adsense",
    "method": "GET",
    "path": "/api/v1/adsense",
    "mcpName": "goanyapi_adsense",
    "description": "Query Reverse AdSense data in exactly one mode: find publisher IDs associated with a domain, or reverse lookup domains associated with a publisher ID.",
    "readOnly": true,
    "docsPath": "/docs/adsense-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "domain": {
          "type": "string",
          "minLength": 1,
          "pattern": "^(?=.{1,253}$)(?!-)(?:[A-Za-z0-9-]{1,63}\\.)+[A-Za-z0-9-]{2,63}$",
          "description": "Domain mode: query publisher IDs associated with a domain. Use a hostname such as example.com and provide this parameter alone."
        },
        "pubId": {
          "type": "string",
          "minLength": 1,
          "pattern": "^[pP][uU][bB]-\\d+$",
          "description": "Publisher ID mode: reverse lookup associated domains. Use the pub- followed by digits format and provide this parameter alone."
        }
      },
      "additionalProperties": false,
      "description": "Choose exactly one query mode: domain or pubId. Do not provide both parameters.",
      "oneOf": [
        {
          "type": "object",
          "required": [
            "domain"
          ]
        },
        {
          "type": "object",
          "required": [
            "pubId"
          ]
        }
      ],
      "examples": [
        {
          "domain": "example.com"
        },
        {
          "pubId": "pub-3661441281163245"
        }
      ]
    }
  },
  {
    "id": "transparency",
    "method": "GET",
    "path": "/api/v1/transparency",
    "mcpName": "goanyapi_google_ads_transparency",
    "description": "Query Google Ads transparency data in exactly one mode: search advertiser and domain suggestions by keyword, find advertisers associated with a domain, or reverse lookup domains by creative IDs.",
    "readOnly": true,
    "docsPath": "/docs/transparency-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "keyword": {
          "type": "string",
          "minLength": 1,
          "description": "Keyword mode: search advertiser and domain suggestions. Provide this parameter alone."
        },
        "domain": {
          "type": "string",
          "minLength": 1,
          "description": "Domain mode: find advertisers associated with a domain. Provide this parameter alone."
        },
        "creativeIds": {
          "type": "string",
          "minLength": 1,
          "description": "Creative lookup mode: find associated domains from comma-separated creative IDs. Provide this parameter alone."
        }
      },
      "additionalProperties": false,
      "description": "Choose exactly one query mode: keyword, domain, or creativeIds.",
      "oneOf": [
        {
          "type": "object",
          "required": [
            "keyword"
          ]
        },
        {
          "type": "object",
          "required": [
            "domain"
          ]
        },
        {
          "type": "object",
          "required": [
            "creativeIds"
          ]
        }
      ],
      "examples": [
        {
          "keyword": "ai image"
        },
        {
          "domain": "example.com"
        },
        {
          "creativeIds": "AR02586610982767820801,AR04020344870890635265"
        }
      ]
    }
  },
  {
    "id": "ads-statistics",
    "method": "GET",
    "path": "/api/v1/ads-statistics",
    "mcpName": "goanyapi_google_ads_transparency_statistics",
    "description": "Query Google Ads transparency statistics across advertiser, domain, title, country, and image-ad actions. Multi-step actions describe the prerequisite action and exact response fields to reuse in their conditional input Schema.",
    "readOnly": true,
    "docsPath": "/docs/ads-statistics-api",
    "inputSchema": {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "advertiserSearch",
            "domainSearch",
            "advertiserStatistics",
            "domainStatistics",
            "titleSearch",
            "googleAdsTitleSearch",
            "domainTitles",
            "hostTitleSearch",
            "domainImageAds",
            "domainTitleCountries",
            "domainTitleImageAds"
          ],
          "description": "Select one statistics action. advertiserSearch: Search advertisers by keyword; domainSearch: Search domains by keyword; advertiserStatistics: Query weekly advertiser statistics. First call advertiserSearch, then pass an exact data.result[].id value as advertiserId.; domainStatistics: Query weekly domain statistics. First call domainSearch, then pass an exact data.result[].id value as hostId.; titleSearch: Search domains by ad title keyword; googleAdsTitleSearch: Find relevant ads through keywords.; domainTitles: Query titles under a domain. First call domainSearch, then pass an exact data.result[].id value as hostId.; hostTitleSearch: Page through titles under a domain. First call domainSearch, then pass an exact data.result[].id value as hostId.; domainImageAds: Query image ads under a domain. First call domainSearch, then pass an exact data.result[].id value as hostId.; domainTitleCountries: Query country distribution for one domain title ad. First call domainTitles and pass the same data.result[] item's hostId and exact title; alternatively call hostTitleSearch and use one data.result.items[] item's hostId and exact title.; domainTitleImageAds: Query image ads for one domain title. First call domainTitles and pass the same data.result[] item's hostId and exact title; alternatively call hostTitleSearch and use one data.result.items[] item's hostId and exact title.."
        },
        "keyword": {
          "type": "string",
          "minLength": 1,
          "description": "Search keyword or optional title filter. Required for: advertiserSearch, domainSearch, titleSearch, googleAdsTitleSearch. Optional for: hostTitleSearch."
        },
        "advertiserId": {
          "type": "string",
          "pattern": "^\\d+$",
          "description": "Plain numeric advertiser ID from advertiserSearch data.result[].id. Required for: advertiserStatistics."
        },
        "hostId": {
          "type": "string",
          "pattern": "^\\d+$",
          "description": "Plain numeric domain host ID from domainSearch or a title result. Required for: domainStatistics, domainTitles, hostTitleSearch, domainImageAds, domainTitleCountries, domainTitleImageAds."
        },
        "title": {
          "type": "string",
          "minLength": 1,
          "description": "Raw ad title returned by a title query. Required for: domainTitleCountries, domainTitleImageAds."
        },
        "startDay": {
          "type": "string",
          "pattern": "^(?:\\d{4}-\\d{2}-\\d{2}|\\d{8})$",
          "description": "Inclusive start date in YYYY-MM-DD or YYYYMMDD format. Required for: advertiserStatistics, domainStatistics, titleSearch, googleAdsTitleSearch, domainTitles, hostTitleSearch, domainImageAds, domainTitleCountries, domainTitleImageAds."
        },
        "endDay": {
          "type": "string",
          "pattern": "^(?:\\d{4}-\\d{2}-\\d{2}|\\d{8})$",
          "description": "Inclusive end date in YYYY-MM-DD or YYYYMMDD format. Required for: advertiserStatistics, domainStatistics, titleSearch, googleAdsTitleSearch, domainTitles, hostTitleSearch, domainImageAds, domainTitleCountries, domainTitleImageAds."
        },
        "page": {
          "type": "integer",
          "default": 0,
          "minimum": 0,
          "description": "Zero-based result page. Optional for: titleSearch, googleAdsTitleSearch, hostTitleSearch."
        },
        "size": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100,
          "description": "Results per page, from 1 to 100. titleSearch and googleAdsTitleSearch default to 10; other paginated actions retain their documented defaults. Optional for: titleSearch, googleAdsTitleSearch, hostTitleSearch."
        }
      },
      "required": [
        "action"
      ],
      "additionalProperties": false,
      "description": "Select one action and provide every parameter required by that action.",
      "oneOf": [
        {
          "type": "object",
          "description": "Search advertisers by keyword",
          "properties": {
            "action": {
              "type": "string",
              "enum": [
                "advertiserSearch"
              ]
            }
          },
          "required": [
            "action",
            "keyword"
          ]
        },
        {
          "type": "object",
          "description": "Search domains by keyword",
          "properties": {
            "action": {
              "type": "string",
              "enum": [
                "domainSearch"
              ]
            }
          },
          "required": [
            "action",
            "keyword"
          ]
        },
        {
          "type": "object",
          "description": "Query weekly advertiser statistics. First call advertiserSearch, then pass an exact data.result[].id value as advertiserId.",
          "properties": {
            "action": {
              "type": "string",
              "enum": [
                "advertiserStatistics"
              ]
            }
          },
          "required": [
            "action",
            "advertiserId",
            "startDay",
            "endDay"
          ]
        },
        {
          "type": "object",
          "description": "Query weekly domain statistics. First call domainSearch, then pass an exact data.result[].id value as hostId.",
          "properties": {
            "action": {
              "type": "string",
              "enum": [
                "domainStatistics"
              ]
            }
          },
          "required": [
            "action",
            "hostId",
            "startDay",
            "endDay"
          ]
        },
        {
          "type": "object",
          "description": "Search domains by ad title keyword",
          "properties": {
            "action": {
              "type": "string",
              "enum": [
                "titleSearch"
              ]
            }
          },
          "required": [
            "action",
            "keyword",
            "startDay",
            "endDay"
          ]
        },
        {
          "type": "object",
          "description": "Find relevant ads through keywords.",
          "properties": {
            "action": {
              "type": "string",
              "enum": [
                "googleAdsTitleSearch"
              ]
            }
          },
          "required": [
            "action",
            "keyword",
            "startDay",
            "endDay"
          ]
        },
        {
          "type": "object",
          "description": "Query titles under a domain. First call domainSearch, then pass an exact data.result[].id value as hostId.",
          "properties": {
            "action": {
              "type": "string",
              "enum": [
                "domainTitles"
              ]
            }
          },
          "required": [
            "action",
            "hostId",
            "startDay",
            "endDay"
          ]
        },
        {
          "type": "object",
          "description": "Page through titles under a domain. First call domainSearch, then pass an exact data.result[].id value as hostId.",
          "properties": {
            "action": {
              "type": "string",
              "enum": [
                "hostTitleSearch"
              ]
            }
          },
          "required": [
            "action",
            "hostId",
            "startDay",
            "endDay"
          ]
        },
        {
          "type": "object",
          "description": "Query image ads under a domain. First call domainSearch, then pass an exact data.result[].id value as hostId.",
          "properties": {
            "action": {
              "type": "string",
              "enum": [
                "domainImageAds"
              ]
            }
          },
          "required": [
            "action",
            "hostId",
            "startDay",
            "endDay"
          ]
        },
        {
          "type": "object",
          "description": "Query country distribution for one domain title ad. First call domainTitles and pass the same data.result[] item's hostId and exact title; alternatively call hostTitleSearch and use one data.result.items[] item's hostId and exact title.",
          "properties": {
            "action": {
              "type": "string",
              "enum": [
                "domainTitleCountries"
              ]
            }
          },
          "required": [
            "action",
            "hostId",
            "title",
            "startDay",
            "endDay"
          ]
        },
        {
          "type": "object",
          "description": "Query image ads for one domain title. First call domainTitles and pass the same data.result[] item's hostId and exact title; alternatively call hostTitleSearch and use one data.result.items[] item's hostId and exact title.",
          "properties": {
            "action": {
              "type": "string",
              "enum": [
                "domainTitleImageAds"
              ]
            }
          },
          "required": [
            "action",
            "hostId",
            "title",
            "startDay",
            "endDay"
          ]
        }
      ],
      "examples": [
        {
          "action": "advertiserSearch",
          "keyword": "ai"
        },
        {
          "action": "domainSearch",
          "keyword": "ai"
        },
        {
          "action": "advertiserStatistics",
          "advertiserId": "39687",
          "startDay": "2026-03-01",
          "endDay": "2026-03-31"
        },
        {
          "action": "domainStatistics",
          "hostId": "53293",
          "startDay": "2026-03-01",
          "endDay": "2026-03-31"
        },
        {
          "action": "titleSearch",
          "keyword": "ai",
          "startDay": "20260122",
          "endDay": "20260321",
          "page": 0,
          "size": 10
        },
        {
          "action": "googleAdsTitleSearch",
          "keyword": "adidas",
          "startDay": "20261001",
          "endDay": "20261008",
          "page": 0,
          "size": 10
        },
        {
          "action": "domainTitles",
          "hostId": "598",
          "startDay": "20260301",
          "endDay": "20260331"
        },
        {
          "action": "hostTitleSearch",
          "hostId": "598",
          "keyword": "ai",
          "startDay": "20260301",
          "endDay": "20260331",
          "page": 0,
          "size": 30
        },
        {
          "action": "domainImageAds",
          "hostId": "598",
          "startDay": "20260301",
          "endDay": "20260331"
        },
        {
          "action": "domainTitleCountries",
          "hostId": "132",
          "title": "AI image tools",
          "startDay": "2026-03-08",
          "endDay": "2026-03-31"
        },
        {
          "action": "domainTitleImageAds",
          "hostId": "132",
          "title": "AI image tools",
          "startDay": "2026-03-08",
          "endDay": "2026-03-31"
        }
      ]
    }
  },
  {
    "id": "activity-credits",
    "method": "GET",
    "path": "/api/v1/activity-credits",
    "mcpName": "goanyapi_activity_credits",
    "description": "Query the authenticated account credit activity.",
    "readOnly": true,
    "inputSchema": {
      "type": "object",
      "properties": {
        "page": {
          "type": "integer",
          "default": 1,
          "minimum": 1,
          "description": "One-based result page"
        },
        "size": {
          "type": "integer",
          "default": 20,
          "minimum": 1,
          "maximum": 100,
          "description": "Results per page, from 1 to 100"
        },
        "type": {
          "type": "string",
          "enum": [
            "grant",
            "consume"
          ],
          "description": "Optional credit transaction type"
        },
        "requestStatus": {
          "type": "string",
          "enum": [
            "empty",
            "failed"
          ],
          "description": "Optional API request result filter"
        }
      },
      "additionalProperties": false
    }
  },
  {
    "id": "credits-balance",
    "method": "GET",
    "path": "/api/v1/credits/balance",
    "mcpName": "goanyapi_credits_balance",
    "description": "Query the authenticated account credit balance.",
    "readOnly": true,
    "docsPath": "/docs/credit-balance-api",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  }
] as const;
