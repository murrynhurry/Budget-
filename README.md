# Budget Tracker 2026

A personal budget app with Pach. Install: open the site in Safari, tap Share, then Add to Home Screen.

Your budget data is saved on your own phone, never in this repository.

## Recipe Box

A second app lives in `recipes/`. Install it the same way from `recipes/` on the site. It signs in with the same account and shares the same space as the budget. Setup: run `recipes-setup.sql` in Supabase, then deploy `supabase/functions/recipe-import` (reads recipes from links; free, no API key).
