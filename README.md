# MTG Board

Offline Commander board for in-person games. Your phone is your board.
Plain HTML/CSS/JS, no build step.

## Put it online (once, from a computer with the GitHub CLI)

    git init -b main
    git add .
    git commit -m "MTG Board"
    gh repo create mtg-board --public --source=. --push
    gh api -X POST "repos/{owner}/mtg-board/pages" -f "source[branch]=main" -f "source[path]=/"
    gh api "repos/{owner}/mtg-board/pages" --jq .html_url

The last command prints the link. It takes about a minute to go live.

## Install on a phone (once each, with internet)

- iPhone: open the link in Safari, Share, Add to Home Screen.
- Android: open the link in Chrome, menu, Install app.

Open it from the home screen icon, import a deck, wait for "Ready offline".

## Updating

Change a file, bump `mtg-shell-v1` in sw.js to v2, commit and push.
Phones pick it up the second time they open the app with signal.
