from PIL import Image
import os
base=r'E:\Ivan\Documents\deepseek-harness\default-workspace\cs16-classic\assets\cs16\ui\hud'
for name in ['640hud8','640hud9','crosshairs']:
    p=os.path.join(base,name+'.png')
    if not os.path.exists(p):
        Image.new('RGBA',(256,256),(0,0,0,0)).save(p)
        print('created',p)
