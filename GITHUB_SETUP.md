# Publishing for Anonymous GitHub

The [Anonymous GitHub](https://anonymous.4open.science) form expects a **public** Git repository URL. Strip author identity before citing the anonymous link in a double-blind submission.

```bash
cd VPAP-WT3DGS-artifact
git add -A
git status   # confirm: no analysis_and_plotting/, no logs/, no .splat, no personal IPs
git commit -m "Update artifact: C4–C6 drivers; remove plotting tree"
git push origin main
```

Then refresh the Anonymous GitHub mirror (dashboard → update / re-anonymize if required) and keep citing only:

`https://anonymous.4open.science/r/<ANON_ID>/`

Do not put author names, affiliations, or institutional emails in README, commits intended for the anonymous view, or committed configs.
