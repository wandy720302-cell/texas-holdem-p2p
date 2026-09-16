# 貼圖資料夾

把要當貼圖用的圖片檔（.png / .jpg / .gif / .webp）直接丟進這個資料夾就好。

檔名建議用英數字，不要用中文或空白（例如 `haha.png`、`angry.gif`），比較不會出問題。

## 圖片放進來之後

還要更新同資料夾裡的 `manifest.json`，把檔名列進去，遊戲才會知道有哪些貼圖可以選。這份清單長這樣：

```json
["haha.png", "angry.gif", "goodgame.png"]
```

**最簡單的方式**：圖片丟進資料夾之後，直接跟我說「我加了哪些貼圖」，我幫你更新 manifest.json 並推上 GitHub。
