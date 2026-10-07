# Budget Tracker 2026

A personal budget app with Pach. Install: open the site in Safari, tap Share, then Add to Home Screen.

Your budget data is saved on your own phone, never in this repository.

## Recipe Box

A second app lives in `recipes/`. Install it the same way from `recipes/` on the site. It signs in with the same account and shares the same space as the budget. Setup: run `recipes-setup.sql` in Supabase, then deploy `supabase/functions/recipe-import` (reads recipes from links) and `supabase/functions/recipe-deals` (weekly flyer deals from Flipp's search, run by Supabase Cron). Both are free; no API key.

## Murry & Matty

A third app lives in `couple/`: your shared calendar, chores, date night ideas, hobbies, restaurants, countdowns and love notes. Install it the same way from `couple/` on the site. It signs in with the same account and shares the same space as the budget and Recipe Box, and stores its lists in the Recipe Box table, so there is nothing extra to set up.

To have a calendar refresh on its own, deploy `supabase/functions/calendar-feed` (fetches a calendar's private iCal link; free, no API key). Then in the app, open Settings → Calendar sync and paste your calendar's secret iCal address.
