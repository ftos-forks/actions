# Example

```yaml
  steps:
  - uses: gittools/actions/gitreleasemanager/open@v3.2.1
    name: Open release with GitReleaseManager
    with:
      token: ${{ secrets.GITHUB_TOKEN }}
      owner: 'someOwner'
      repository: 'someRepository'
      milestone: '0.1.0'
```
