#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#include <string.h>
static void hex(CFDataRef data){const UInt8 *p=CFDataGetBytePtr(data);for(CFIndex i=0;i<CFDataGetLength(data);i++)printf("%02x",p[i]);putchar('\n');}
static SecKeyRef hardware_key(void){
  const char *name="com.serenetia.tia-launcher.developer-device.v1";
  CFDataRef tag=CFDataCreate(NULL,(const UInt8 *)name,strlen(name));
  const void *keys[]={kSecClass,kSecAttrApplicationTag,kSecAttrKeyType,kSecReturnRef};
  const void *values[]={kSecClassKey,tag,kSecAttrKeyTypeECSECPrimeRandom,kCFBooleanTrue};
  CFDictionaryRef query=CFDictionaryCreate(NULL,keys,values,4,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
  SecKeyRef key=NULL;OSStatus status=SecItemCopyMatching(query,(CFTypeRef *)&key);CFRelease(query);
  if(status==errSecItemNotFound){
    CFErrorRef error=NULL;
    SecAccessControlRef access=SecAccessControlCreateWithFlags(NULL,kSecAttrAccessibleWhenUnlockedThisDeviceOnly,kSecAccessControlPrivateKeyUsage,&error);
    if(!access){if(error)CFRelease(error);CFRelease(tag);return NULL;}
    const void *privateKeys[]={kSecAttrIsPermanent,kSecAttrApplicationTag,kSecAttrAccessControl};
    const void *privateValues[]={kCFBooleanTrue,tag,access};
    CFDictionaryRef privateAttrs=CFDictionaryCreate(NULL,privateKeys,privateValues,3,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
    int bits=256;CFNumberRef bitSize=CFNumberCreate(NULL,kCFNumberIntType,&bits);
    const void *createKeys[]={kSecAttrKeyType,kSecAttrKeySizeInBits,kSecAttrTokenID,kSecPrivateKeyAttrs};
    const void *createValues[]={kSecAttrKeyTypeECSECPrimeRandom,bitSize,kSecAttrTokenIDSecureEnclave,privateAttrs};
    CFDictionaryRef attributes=CFDictionaryCreate(NULL,createKeys,createValues,4,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
    key=SecKeyCreateRandomKey(attributes,&error);
    CFRelease(attributes);CFRelease(bitSize);CFRelease(privateAttrs);CFRelease(access);if(error)CFRelease(error);
  }
  CFRelease(tag);
  if(!key)return NULL;
  CFDictionaryRef attrs=SecKeyCopyAttributes(key);
  CFTypeRef token=attrs?CFDictionaryGetValue(attrs,kSecAttrTokenID):NULL;
  int hardware=token && CFEqual(token,kSecAttrTokenIDSecureEnclave);
  if(attrs)CFRelease(attrs);if(!hardware){CFRelease(key);return NULL;}return key;
}
int main(int argc,char **argv){
  if(argc!=2 || (strcmp(argv[1],"public") && strcmp(argv[1],"sign")))return 2;
  SecKeyRef key=hardware_key();if(!key){fputs("Secure Enclave key unavailable.\n",stderr);return 1;}
  CFErrorRef error=NULL;CFDataRef result=NULL;
  if(!strcmp(argv[1],"public")){
    SecKeyRef publicKey=SecKeyCopyPublicKey(key);if(publicKey){result=SecKeyCopyExternalRepresentation(publicKey,&error);CFRelease(publicKey);}
  }else{
    unsigned char message[1025];size_t length=fread(message,1,sizeof(message),stdin);
    if(length<20 || length>1024 || memcmp(message,"tia-launcher-dev/v1\n",20)){CFRelease(key);return 2;}
    CFDataRef input=CFDataCreate(NULL,message,length);
    result=SecKeyCreateSignature(key,kSecKeyAlgorithmECDSASignatureMessageX962SHA256,input,&error);CFRelease(input);
  }
  CFRelease(key);if(error)CFRelease(error);if(!result){fputs("Hardware operation failed.\n",stderr);return 1;}
  hex(result);CFRelease(result);return 0;
}
