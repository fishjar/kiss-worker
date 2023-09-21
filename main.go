package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path"
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

const (
	ENV_APP_KEY        = "APP_KEY"
	ENV_DATA_PATH      = "DATA_PATH"
	DEFAULT_APP_KEY    = "123456"
	DEFAULT_DATA_PATH  = "data"
	KV_SALT_SYNC       = "KISS-Translator-SYNC"
	KV_SALT_SHARE      = "KISS-Translator-SHARE"
	KV_RULES_SHARE_KEY = "kiss-rules-share.json"
)

var config = struct {
	appKey  string
	dataDir string
}{}

type kvData struct {
	Key      string `form:"key" json:"key" binding:"required"`
	Value    string `form:"value" json:"value" binding:"required"`
	UpdateAt int64  `form:"updateAt" json:"updateAt"`
}

func getEnvValue(key string, defaultValue string) string {
	val := os.Getenv(key)
	if val != "" {
		return val
	}
	return defaultValue
}

func calSha256(text string, salt string) string {
	h := sha256.New()
	h.Write([]byte(text))
	h.Write([]byte(salt))
	return hex.EncodeToString(h.Sum(nil))
}

func checkDirExist() error {
	stat, err := os.Stat(config.dataDir)
	if os.IsNotExist(err) || !stat.IsDir() {
		return os.MkdirAll(config.dataDir, 0700)
	}
	return err
}

func handleSync(c *gin.Context) {
	expectPsk := fmt.Sprintf("Bearer %s", calSha256(config.appKey, KV_SALT_SYNC))
	psk := c.GetHeader("Authorization")
	if psk != expectPsk {
		log.Printf("invalid key, psk: %s, expectPsk: %s", psk, expectPsk)
		c.JSON(400, gin.H{"message": "invalid key."})
		return
	}

	if err := checkDirExist(); err != nil {
		log.Printf("check dir: %s", err)
		c.JSON(500, gin.H{"message": "check dir err"})
		return
	}

	var req kvData
	if err := c.ShouldBind((&req)); err != nil {
		log.Printf("req bind: %s", err)
		c.JSON(400, gin.H{"message": "req bind err"})
		return
	}

	filepath := path.Join(config.dataDir, req.Key)
	stat, err := os.Stat(filepath)

	if err != nil && !os.IsNotExist(err) {
		log.Printf("check file: %s", err)
		c.JSON(500, gin.H{"message": "check file err"})
		return
	}

	if err == nil && !stat.IsDir() {
		data, err := os.ReadFile(filepath)
		if err != nil {
			log.Printf("read file: %s", err)
			c.JSON(500, gin.H{"message": "read file err"})
			return
		}

		var res kvData
		_ = json.Unmarshal(data, &res)

		if res.UpdateAt >= req.UpdateAt {
			c.JSON(200, res)
			return
		}
	}

	if req.UpdateAt == 0 {
		req.UpdateAt = time.Now().Unix()
	}

	data, _ := json.MarshalIndent(req, "", "  ")
	if err := os.WriteFile(filepath, data, 0666); err != nil {
		log.Printf("write file: %s", err)
		c.JSON(500, gin.H{"message": "write file err"})
		return
	}

	c.JSON(200, req)
}

func handleRules(c *gin.Context) {
	psk := c.Query("psk")
	expectPsk := calSha256(config.appKey, KV_SALT_SHARE)
	if psk != expectPsk {
		log.Printf("invalid key, psk: %s, expectPsk: %s", psk, expectPsk)
		c.JSON(400, gin.H{"message": "invalid key"})
		return
	}

	if err := checkDirExist(); err != nil {
		log.Printf("check dir: %s", err)
		c.JSON(500, gin.H{"message": "check dir err"})
		return
	}

	filepath := path.Join(config.dataDir, KV_RULES_SHARE_KEY)
	stat, err := os.Stat(filepath)
	if os.IsNotExist(err) || stat.IsDir() {
		c.JSON(404, gin.H{"message": "not found"})
		return
	} else if err != nil {
		log.Printf("stat file: %s", err)
		c.JSON(500, gin.H{"message": "stat file err"})
		return
	}

	data, err := os.ReadFile(filepath)
	if err != nil {
		log.Printf("read file: %s", err)
		c.JSON(500, gin.H{"message": "read file err"})
		return
	}

	var res kvData
	_ = json.Unmarshal(data, &res)

	c.Data(200, "application/json; charset=utf-8", []byte(res.Value))
}

func main() {
	r := gin.Default()
	corsConf := cors.DefaultConfig()
	corsConf.AllowOrigins = []string{"*"}
	corsConf.AllowHeaders = []string{"*"}
	r.Use(cors.New(corsConf))
	r.POST("/sync", handleSync)
	r.GET("/rules", handleRules)
	r.Run()
}

func init() {
	rootDir, _ := os.Getwd()
	dataPath := getEnvValue(DEFAULT_DATA_PATH, DEFAULT_DATA_PATH)
	config.dataDir = path.Join(rootDir, dataPath)
	config.appKey = getEnvValue(ENV_APP_KEY, DEFAULT_APP_KEY)

	log.SetPrefix("[KISS] ")
}
