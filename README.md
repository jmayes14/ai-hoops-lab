# AI Hoops Lab

Two teams of AI agents play 5-on-5 basketball on a 3D court. You coach them: change each team's game plan and each player's skills, then watch how the game changes. Click any player to see what that agent is thinking.

## Run it

It's a static site with no build step. Serve the folder and open it in a browser:

```
python3 -m http.server 8813
# then open http://localhost:8813
```

(Opening `index.html` straight from disk won't work, because browsers block ES modules on `file://`.)

## How the agents work

- **Ball handler:** several times a second, it scores every option: shoot, pass to each teammate, drive, or hold. Each score is about *expected points* (chance of making × 2 or 3). Passes lose points for defenders near the passing lane. The team's game plan nudges the scores, and a late shot clock makes shooting more urgent. Basketball IQ controls how much random noise is added, so low-IQ players make worse choices.
- **Off the ball:** players space to formation spots (five-out, four-out-one-in, or two bigs, depending on shot choice). Smart players cut to the basket when their defender is watching the ball.
- **Defense:** man-to-man (stay between your player and the basket, with help on drives) or a 2-3 zone that shifts with the ball. Pressure sets how tight defenders play and how often they go for steals.
- **Rebounds:** missed shots bounce off the rim with real physics; the nearest players chase, defenders box out, and rebounding skill helps win the ball.

## Coaching controls

- **Team game plan:** pace, shot choice (rim vs. threes), ball movement, man or zone defense, and pressure, plus presets.
- **Player skills:** speed, inside scoring, 3-point shooting, passing, defense, rebounding and basketball IQ.
- **View:** TV, follow, baseline, top and free (drag to orbit) cameras; 1×/2×/4× speed; "Show AI thinking" overlay.

## Files

| File | What it is |
|---|---|
| `index.html` | Page layout |
| `style.css` | Styles |
| `game.js` | Simulation, AI agents, Three.js 3D view and coach UI |

Three.js 0.160.0 is loaded from jsDelivr.

## Testing hooks

- `?sim=10` runs 10 full games without drawing and prints box-score totals (used to balance shooting and pace).
- `?ff=30` fast-forwards 30 seconds; `?pick=3` selects player 3.

Team and player names are made up. This is an original game, not based on any league or video game.
