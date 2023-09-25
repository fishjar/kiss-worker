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
	ENV_DATA_PATH      = "APP_DATAPATH"
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

func loadData(key string) (*kvData, error) {
	if err := checkDirExist(config.dataDir); err != nil {
		return nil, err
	}

	filepath := path.Join(config.dataDir, key)
	data, err := os.ReadFile(filepath)
	if err != nil {
		return nil, err
	}

	var kv kvData
	_ = json.Unmarshal(data, &kv)
	return &kv, nil
}

func (kv *kvData) save() error {
	if err := checkDirExist(config.dataDir); err != nil {
		return err
	}

	filepath := path.Join(config.dataDir, kv.Key)
	data, _ := json.MarshalIndent(kv, "", "  ")
	return os.WriteFile(filepath, data, 0644)
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

func checkDirExist(dir string) error {
	stat, err := os.Stat(dir)
	if os.IsNotExist(err) || !stat.IsDir() {
		return os.MkdirAll(dir, 0700)
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

	var req kvData
	if err := c.ShouldBind((&req)); err != nil {
		log.Printf("req bind: %s", err)
		c.JSON(400, gin.H{"message": "req bind err"})
		return
	}

	res, err := loadData(req.Key)
	if err != nil && !os.IsNotExist(err) {
		log.Printf("load data: %s", err)
		c.JSON(500, gin.H{"message": "load data err"})
		return
	} else if err == nil && res.UpdateAt >= req.UpdateAt {
		c.JSON(200, res)
		return
	}

	if req.UpdateAt == 0 {
		req.UpdateAt = time.Now().Unix()
	}
	if err := req.save(); err != nil {
		log.Printf("save data: %s", err)
		c.JSON(500, gin.H{"message": "save data err"})
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

	res, err := loadData(KV_RULES_SHARE_KEY)
	if os.IsNotExist(err) {
		c.JSON(404, gin.H{"message": "not found"})
		return
	} else if err != nil {
		log.Printf("load data: %s", err)
		c.JSON(500, gin.H{"message": "load data err"})
		return
	}

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
	log.SetPrefix("[KISS] ")

	rootDir, _ := os.Getwd()
	dataPath := getEnvValue(ENV_DATA_PATH, DEFAULT_DATA_PATH)
	config.dataDir = path.Join(rootDir, dataPath)
	config.appKey = getEnvValue(ENV_APP_KEY, DEFAULT_APP_KEY)
}
