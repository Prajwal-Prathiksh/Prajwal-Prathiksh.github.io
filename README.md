# Prajwal-Prathiksh.github.io
The Personal Website of K T Prajwal Prathiksh

> **Note:** The website is currently under development! 🙂


*In the mean time, here's some food for thought!*

<p align="center">
  <img src="https://cdn.quotesgram.com/img/58/48/1693387607-calvinHobbes.jpg" width="650" title="https://cdn.quotesgram.com/img/58/48/1693387607-calvinHobbes.jpg">
</p>

## Building & Deploying the Website 

### Branch Structure of the Repository
* `main` : This is the main branch of the repository from which the website is deployed using **GitHub Actions** *(Contains only those files necessary for the website)*
* `gh_pages_src`: This branch contains all of the markdown, CSS and HTML files using which the website is built locally. The files which are built locally, are stored in the `_site` folder. All of these files constitute the `main` branch, from which the website is built.

### Deploying Locally (For Testing)
1. From the `gh_pages_src` branch, run the following command from `\root`:
```
$ bundle exec jekyll serve
```

### Building Locally (Pre-Deployment)
1. From the `gh_pages_src` branch, run the following command from `\root`:
```
$ bundle exec jekyll build
```

### Deploying Online
1. Copy all of the files in the `_site` folder to the `main` branch.
2. Push the changes to the `main` branch

