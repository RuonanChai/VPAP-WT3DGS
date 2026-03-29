# Publishing to GitHub (required for Anonymous GitHub mirror)

The [Anonymous GitHub](https://anonymous.4open.science) “Anonymize your repository” form expects a **public GitHub repository URL**. The coding assistant **cannot** log into your GitHub account or click “New repository” for you.

## Option A — GitHub website

1. Create a **new public** repository (e.g. `VPAP-WT3DGS`).
2. Do **not** add a README/license on GitHub if you already have them locally (avoid merge hassle).
3. In this folder:

```bash
cd VPAP-WT3DGS-artifact
git init
git add .
git commit -m "Initial VPAP-WT3DGS artifact"
git branch -M main
git remote add origin https://github.com/<YOUR_USER>/<REPO>.git
git push -u origin main
```

4. Paste `https://github.com/<YOUR_USER>/<REPO>` into Anonymous GitHub.

## Option B — GitHub CLI (`gh`)

```bash
cd VPAP-WT3DGS-artifact
git init
git add .
git commit -m "Initial VPAP-WT3DGS artifact"
gh repo create VPAP-WT3DGS --public --source=. --remote=origin --push
```

Use a **double-blind–safe** account or organization if your venue requires it; follow the conference’s anonymity rules.
