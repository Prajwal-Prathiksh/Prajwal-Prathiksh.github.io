Archive of OSF Storage for 'The Visual Mandela Effect: Evidence for Shared Specific False Memories'
==================================================================================================
This repository contains the data needed to reproduce the results of Prasad & Bainbridge (2022). We have made the data publically available under the Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International Public License (see 'license.txt' for more details). Below is a detailed description of what files are in each folder, and how the data is organized in the file. If you have any additional questions, you can contact the corresponding author at wilma@uchicago.edu.

Folder 0. Stimuli:
    /Simulus Images:
        contains the icon sets used as stimuli images in many of the experiments of Prasad & Bainbridge (2022). There were forty icons, each with three versions, for a total of 120 images.
        - Images labeled with 'Original' indicate that the image has not been edited or manipulated by the researchers.
        - Images labeled with 'Manipulation 1' have been edited from the original by the researchers; Manipulation 1 images were defined as the manipulation which received the highest proportion of incorrect responses during Experiement 1.
        - Images labeled with 'Manipulation 2' were also edited from the original by the researchers; Manipulation 2 images were defined as the remaining manipulation (didn't receive the highest proportion of incorrect responses).
    32_Images.csv
        lists all of the icons used as stimuli in Experiment 4 and in the BubbleView experiment (detailed in supplement)
        - icons were divided into 4 categories based off of accuracy & familiarity ratings from Experiment 1
        - one image from each category was dropped from the analyses, because the Pringles logo was changed by the brand during the data collection portion of the study
    28_Images.csv
        list of icons used as stimuli in Experiment 2 and in the final analysis for Experiment 4 and in the BubbleView experiment (detailed in supplement)
        - icons were divided into 4 categories: VME-Apparent icons, Low Familiarity icons, Medium Familiarity icons, and High Familiarity icons

Folder 1. Experiment 1:
    Image_Choice_Data.csv
        contains participant responses for which image version they think is correct
        - each row is a participant, each column is an icon
        - 1 is chose Original verion (correct), 2 is chose Manipulation 1 version (incorrect), and 3 is chose Manipulation 2 version (incorrect); NaN is no response
    Image_Confidence_Data.csv
        contains participant confident ratings for each image choice questions
        - each row is a participant, each column is an icon
        - 1 to 5 Likert scale, where 1 is not at all confident and 5 is extremely confident; NaN is no response
    Image_Familiarity_Data.csv
        contains participant familiarity ratings for each image choice questions
        - each row is a participant, each column is an icon
        - 1 to 5 Likert scale, where 1 is not at all familiar and 5 is extremely familiar; NaN is no response
    Image_SeenBefore_Data.csv
        contains participant ratings for approximately how many times they've seen the icon before
        - each row is a participant, each column is an icon
        - 0 is seen 0 times before, 1 is seen 1-10 times before, 11 is seen 11-50 times before, 51 is seen 51-100 times before, 101 is seen 101-1000 times before, and 1000 is seen 1000+ times before; NaN is no response

Folder 2. Experiment 2:
    MouseTrack_Data.mat
        contains the behavioral data for Experiment 2; listed below are the variables contained within the file and their description
        - imgs: name of each image used in experiment
        - imgcat: category of each image used in experiment (index aligns with imgs)
        - metaData: data for questions at end: "what thought experiment about" & "have heard of Mandela Effect?"
            - subNum: subject number
            - about: subject response to what they thought the experiment was about
            - me: subject response to if they have heard of the Mandela Effect before (0 is no, 1 is yes)
        - mouseData: data for the study & test phase of experiment
            - sub_num: subject number used in analysis
            - cog_num: participant number on cognition.run, experiment hosting platform used
            - imgname: name of image seen in trial
            - category: category of trial image
            - window_h: height of participant viewing window during study phase (in pixels)
            - window_w: width of participant viewing window during study phase (in pixels)
            - positionX: horizontal position of image during study phase (from left edge of viewing window)
            - positionY: vertical position of image during study phase (from topmost edge of viewing window)
            - xData: horizontal position of mouse at each recorded timepoint during study phase (from left edge of viewing window)
            - yData: vertical position of mouse at each recorded timepoint (from topmost edge of viewing window)
            - timeData: each recorded timepoint of mouse position
            - accuracy: participant accuracy in choosing the correct image during the test phase; 0 is incorrect choice, 1 is correct choice
            - reason: participant reported reason for why chose image version they did in test phase
            - confidence: confidence in choice for image during test phase (1 to 5 Likert scale, where 1 is not at all confident and 5 is extremely confident)
            - familiarity: familiarity with image shown in test phase trial (1 to 5 Likert scale, where 1 is not at all familiar and 5 is extremely familiar)


Folder 3. Experiment 3:
    /[image_query]
        each folder contains the 100 images scraped from the search query, which is the name of the folder

Folder 4. Experiment 4:
    /Drawings
        contains all drawing results: each file label is labeled with the convention [Name of Image]_[Task Type]_[Subject Number]. where 'Task Type' is whether they did a drawing from long term (LT) or short term (ST) memory
    Drawing_RawData.mat
        contains the drawing data for Experiment 4; listed below are the variables contained within the file and their description
        - dataTbl:
            - SubjectID: participant number on cognition.run, experiment hosting platform used
            - Input_imgname: name of image asked to draw
            - Answer_drawing: data needed to render drawing made by participant
            - Answer_familiarity: familiarity score rated by participant before drawing (1 to 5 Likert scale, where 1 is not at all familiar and 5 is extremely familiar)
            - Answer_mousemove: position of mouse at each recorded timepoint; each row contains the x position, the y position, and the timestamp
            - Answer_wpaintbottom: drawing canvas information (needed for rendering drawings)
            - Answer_wpaintleft: drawing canvas information (needed for rendering drawings)
            - Answer_wpaintright: drawing canvas information (needed for rendering drawings)
            - Answer_wpainttop: drawing canvas information (needed for rendering drawings)
    Drawing_Scores.xlsx
        containes the collated drawing error scores from all 3 scorers
        - File Name: name of drawing file, arranged in alphabetic order
        - Image: name of icon drawing depicted
        - Task Type: whether task was from long term (LT) or short term (ST) memory
        - VME or not?: whether icon belonged to VME category or did not
        - Possible to show VME?: if area that contains VME feature is drawn (e.g. if legs for C3P0 are drawn)
        - If so, does VME feature exist?: for drawings that are VME and have the affected area drawn, do people make the VME error
        - all subsequent columns are errors noted in the drawings by the scorers; a 1 in the column means that the error was present

Folder 5. supplementary Data:
    BubbleView_Data.mat
    contains the behavioral data for the BubbleView experiment (detailed in supplement); listed below are the variables contained within the file and their description
        -bvsubdata: structure containing all participant data used in analysis
            - subject: subject ID number
            - condition: condition number (for which pseudorandomized image version list participants saw)
            - [image name]: contains the data for the icon
                - name: name of icon seen
                - filename: filename of image presented
                - category: image category for icon (VME-apparent, Low Familiarity, Medium Familiarity, or High Familiarity)
                - Type: image version seen (1 is Original version, 2 is Manipulation 1 version, 3 is Manipulation 2 version)
                - investigate: data for the investigative phase of the experiment
                    - viewing_duration: how long (in ms) participants investigated the blurred image using BubbleView
                    - mouse_track: each row is record the position of the mouse at that time; the columns are described below
                        - 1st column - timestamp (in ms)
                        - 2nd column - x position from center of image
                        - 3rd column - y position from center of image
                        - 4th column - if mouse was clicked (0 is no, 1 is yes)
                    - valid_clicks: contains mouse position data for only the clicks that were within the bounds of the image
                        - 1st column - timestamp (in ms)
                        - 2nd column - x position from center of image
                        - 3rd column - y position from center of image
                        - 4th column - if mouse was clicked (0 is no, 1 is yes)
                    - heatmap: generated using valid valid_clicks
                - decision: data regarding if the participant decided that the image they investigated was the correct version or not
                    - correct_response: what the correct response was (0 is that the image participant investigated was correct version, 1 is that the image participant investigated was a manipulated fake version)
                    - response: what the participant response was (0 is that the participant thought it was correct version, 1 is that the participant thought it was a manipulated fake version)
                    - rt: response time (in ms)
                - informative: data for the informative phase of the experiment
                    - viewing_duration: how long (in ms) participants took to pick the area most informative for their decision
                    - mouse_track: each row is record the position of the mouse at that time; the columns are described below
                        - 1st column - timestamp (in ms)
                        - 2nd column - x position from center of image
                        - 3rd column - y position from center of image
                        - 4th column - if mouse was clicked (0 is no, 1 is yes)
                    - valid_clicks: contains mouse position data for only the clicks that were within the bounds of the image
                        - 1st column - timestamp (in ms)
                        - 2nd column - x position from center of image
                        - 3rd column - y position from center of image
                        - 4th column - if mouse was clicked (0 is no, 1 is yes)
                    - heatmap: generated using valid valid_clicks
                - confidence: data for confidence ratings in their choice
                    - response: confidence in choice of whether image investigated was real or fake (1 to 5 Likert scale, where 1 is not at all confident and 5 is extremely confident)
                    - rt: response time for confidence rating (in ms)
                - familiarity: data for familiarity ratings with the image investigated
                    - response: familiarity ratings with the image investigated (1 to 5 Likert scale, where 1 is not at all familiar and 5 is extremely familiar)
                    - rt: response time for familiarity rating (in ms)
