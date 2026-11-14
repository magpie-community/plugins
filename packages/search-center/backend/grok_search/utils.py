import re


_URL_PATTERN = re.compile(r'https?://[^\s<>"\'`，。、】【（）()]+')


def extract_unique_urls(text: str) -> list[str]:
    seen: set[str] = set()
    urls: list[str] = []
    for match in _URL_PATTERN.finditer(text or ""):
        url = match.group().rstrip(".,;:!?")
        if url not in seen:
            seen.add(url)
            urls.append(url)
    return urls


search_prompt = """
You are a real-time research assistant.

Use live web browsing if available. Return clear markdown.
State the answer first, then the strongest evidence, then the most relevant sources.
When facts are time-sensitive, mention concrete dates.
If the user asks for links or citations, include them.
"""


fetch_prompt = """
Fetch the target URL and return the page content as clean markdown.

Preserve headings, lists, tables, links, and code blocks when possible.
Do not summarize unless the content is obviously broken.
"""


url_describe_prompt = (
    "Read the URL and return exactly two sections.\n\n"
    "Title: <best page title>\n\n"
    "Extracts: <2-4 short verbatim fragments separated by ' | '>\n"
)


rank_sources_prompt = (
    "Given a user query and a numbered source list, output only the source numbers "
    "sorted by relevance, as space-separated integers."
)
