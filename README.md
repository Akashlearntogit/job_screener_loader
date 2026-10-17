# Job Screener (Team) — loader

This public repo holds only the small Tampermonkey **loader** for the team's job screener, so Tampermonkey can keep it up to date automatically.

**Install:** with Tampermonkey installed, open
https://raw.githubusercontent.com/Akashlearntogit/job_screener_loader/main/job-screener-loader.user.js
and click **Install**. That's the only install; updates arrive by themselves.

**What's here and what isn't:** this file contains no access keys, client profiles, or screening logic. On each computer it uses that person's own read-only key to download the screener and the client profiles from the team's private repo. Without a key it does nothing.

This copy is published from the private repo (`loader/job-screener-loader.user.js`); don't edit it here.
