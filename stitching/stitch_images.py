import cv2
import numpy as np
import os
from glob import glob

def load_images_from_folder(folder):
    image_paths = sorted(glob(os.path.join(folder, "*.JPG")))  # Adjust extension as needed
    images = [cv2.imread(img_path) for img_path in image_paths]
    return images

def stitch_images(images):
    stitcher = cv2.Stitcher_create()
    stitcher.setPanoConfidenceThresh(0.5)  # Adjust confidence threshold if needed
    status, stitched = stitcher.stitch(images)
    if status != cv2.Stitcher_OK:
        print("Error during stitching:", status)
        return None
    return stitched

if __name__ == "__main__":
    folder_path = "top_row"  # Replace with your image folder
    images = load_images_from_folder(folder_path)
    print("IMAGES LOADED:", len(images))
    stitched_image = stitch_images(images)
    
    if stitched_image is not None:
        name = "stitched_fish"
        cv2.imwrite(f"output/{name}.jpg", stitched_image)
        print(f"Stitched image saved as {name}.jpg")
