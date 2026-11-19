import {
  API_BASE,
  CACHE_TTL,
  DEFAULT_MAX_TEXT_LENGTH,
  PROVIDER,
  RETRY,
  USER_AGENT,
} from "./config.mjs";
import { Cache, cacheKey } from "./cache.mjs";
import { Credentials } from "./credentials.mjs";
import { APIError, AuthenticationError, request } from "./request.mjs";
import { createTools, sortBy, unixSeconds, validate, SORT_FIELDS, TIME_FIELDS } from "./tools.mjs";
import { createWebSearch } from "./websearch.mjs";
import * as normalize from "./normalize.mjs";

export const _internal = {
  Cache,
  cacheKey,
  Credentials,
  createTools,
  createWebSearch,
  sortBy,
  unixSeconds,
  validate,
  request,
  APIError,
  AuthenticationError,
  normalize,
  API_BASE,
  PROVIDER,
  USER_AGENT,
  SORT_FIELDS,
  TIME_FIELDS,
  RETRY,
  CACHE_TTL,
  DEFAULT_MAX_TEXT_LENGTH,
};
