# Contributing

Search Center is a Windows Magpie plugin with a bundled Python search backend.
Keep provider calls in the backend/worker path and routing in `center.mjs`.
Do not add account credentials, query history or machine-specific paths to the repository.

## Checks

Install Python dependencies with `scripts/setup.ps1`, then run the Node checks:

```powershell
npm test
node scripts/audit-package.mjs
```

Python backend tests, from the repository root using the installed environment:

```powershell
& "$env:USERPROFILE/.magpie-search-center/venv/Scripts/python.exe" -B -c "import sys, unittest; sys.path.insert(0, 'backend'); result = unittest.TextTestRunner().run(unittest.defaultTestLoader.discover('backend-tests')); sys.exit(not result.wasSuccessful())"
```

`tests/release-smoke.mjs` exports a browser check accepting a Playwright Page. It uses an isolated data directory and a local simulated provider, covering UI save/reload, model discovery, DPAPI and Responses. Set `SEARCH_CENTER_DATA_DIR` to a fresh test directory, `SEARCH_CENTER_PYTHON` to the isolated environment's executable and `SEARCH_CENTER_SCREENSHOT` to an output PNG path. Optional `SEARCH_CENTER_PACKAGE_ROOT` points the test at an extracted package. Playwright is a development tool, not a runtime requirement.

For Magpie integration, use a separate test home and ports as described in the [community testing script](https://github.com/magpie-community/plugins/blob/main/scripts/try.sh). On Windows, `USERPROFILE` must be isolated as well as `HOME`. Do not register a test copy in a user's live plugin library.

Preserve third-party notices when modifying borrowed code. Describe behavior changes and the checks actually performed in a pull request.
