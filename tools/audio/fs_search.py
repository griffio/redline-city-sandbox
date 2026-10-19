import sys, re, json, html, urllib.request, urllib.error, urllib.parse, time
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
def fetch(url, tries=5):
    for k in range(tries):
        try:
            time.sleep(2.5)
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code != 429 or k == tries - 1: raise
            time.sleep(15 * (k + 1))
def search(q, page=1):
    url = "https://freesound.org/search/?" + urllib.parse.urlencode({"q": q, "page": page})
    s = fetch(url)
    out = []
    for block in s.split('class="bw-search__result"')[1:]:
        m = re.search(r'data-sound-id="(\d+)"\s+data-username="([^"]+)"', block)
        if not m: continue
        g = lambda k: (re.search(k + r'="([^"]*)"', block) or [None, ""])[1]
        lic = (re.search(r'title="License: ([^"]+)"', block) or [None, "?"])[1]
        out.append({"id": int(m[1]), "user": m[2], "title": html.unescape(g("data-title")),
                    "dur": float(g("data-duration") or 0), "sr": g("data-samplerate"),
                    "dl": int(g("data-num-downloads") or 0), "license": lic,
                    "mp3": g("data-mp3").replace("-lq.mp3", "-hq.mp3")})
    return out
if __name__ == "__main__":
    seen = {}
    for q in sys.argv[1:]:
        for r in search(q):
            if "NonCommercial" in r["license"] or "Sampling" in r["license"]: continue
            r.setdefault("q", q); seen.setdefault(r["id"], r)
        time.sleep(1)
    json.dump(list(seen.values()), sys.stdout, indent=0)

def search_user(user, q="", pages=4):
    out = []
    for page in range(1, pages + 1):
        url = "https://freesound.org/search/?" + urllib.parse.urlencode({"q": q, "f": f'username:"{user}"', "page": page, "s": "Date added (newest first)"})
        s = fetch(url)
        n0 = len(out)
        for block in s.split('class="bw-search__result"')[1:]:
            m = re.search(r'data-sound-id="(\d+)"\s+data-username="([^"]+)"', block)
            if not m: continue
            g = lambda k: (re.search(k + r'="([^"]*)"', block) or [None, ""])[1]
            lic = (re.search(r'title="License: ([^"]+)"', block) or [None, "?"])[1]
            out.append({"id": int(m[1]), "user": m[2], "title": html.unescape(g("data-title")), "dur": float(g("data-duration") or 0),
                        "license": lic, "mp3": g("data-mp3").replace("-lq.mp3", "-hq.mp3")})
        if len(out) == n0: break
        time.sleep(0.8)
    return out
